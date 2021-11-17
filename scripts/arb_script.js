const { JsonRpcProvider } = require('@ethersproject/providers');
const { ethers } = require("hardhat");
const { expect, util } = require("chai");
const { utils, Wallet } = require('ethers');
const { BigNumber, constants } = ethers;
const { AddressZero, MaxUint256, MaxInt256 } = constants;

const { loadLemmaInfo, snapshot, revertToSnapshot, doRequest, replaceAll, tokenTransfers, sqrt } = require("../test/utils");
const { TICK_SPACINGS, FeeAmount, encodePriceSqrt, getMaxTick, getMinTick } = require("../test/uniswapUtils");

const INonfungiblePositionManager = require("@uniswap/v3-periphery/artifacts/contracts/interfaces/INonfungiblePositionManager.sol/INonfungiblePositionManager.json");
const IUniswapV3Factory = require("@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json");
const IUniswapV3Pool = require("@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json");
const IUniswapV3PoolState = require("@uniswap/v3-core/artifacts/contracts/interfaces/pool/IUniswapV3PoolState.sol/IUniswapV3PoolState.json");
const { parseEther } = require('ethers/lib/utils');

// Use to compute percentages
const BN1E6 = BigNumber.from("1000000");

const printTx = async (hash) => {
    await tokenTransfers.print(hash, [], false);
};

/**
 * This function should estimate the real execution price given from marginal price and the amount 
 * Currently there is only a trivial implementation considering a fixed amount of slippage but with UniswapV3 it actually depends on the specific shape of the curve which is non trivial to estimate because of concentrate liquidity
 * @param {BigNumber} marginalPrice 
 * @param {BigNumber} targetPrice
 */
function estimateExecutionPriceOnPriceDelta(marginalPrice, targetPrice) {
    return (marginalPrice.add(targetPrice)).div(BigNumber.from("2"));
}

const calculateOptimumWETHToBorrowAndUSDLToMint = async (defaultSigner, swapRouter, usdLemma, perpetualDEXWrapper, collateral, uniswapV3Factory, poolFee) => {

    //get mint price for 1 USDL
    //assume this as the target price
    const mintPriceOnLemma = await perpetualDEXWrapper.callStatic.getCollateralAmountGivenUnderlyingAssetAmount(utils.parseEther("1"), true);
    console.log("mintPriceOnLemma", mintPriceOnLemma.toString());

    // TODO: Check this 
    const redeemPriceOnLemma = mintPriceOnLemma;
    console.log("redeemPriceOnLemma", redeemPriceOnLemma.toString());

    const uniswapV3PoolAddress = await uniswapV3Factory.getPool(collateral.address, usdLemma.address, poolFee);
    console.log('uniswapV3PoolAddress for weth and usdl(for 3000 fees) ', uniswapV3PoolAddress);
    const poolInstance = await ethers.getContractAt(IUniswapV3Pool.abi, uniswapV3PoolAddress);
    const {sqrtPriceX96} = await poolInstance.slot0();

    const token0Price = sqrtPriceX96.mul(sqrtPriceX96).mul(parseEther('1')).div(BigNumber.from(2).pow(192)); // weth price like 1 weth = 1700 usdl per eth output
    // token1Price
    const uniswapPrice = (BigNumber.from(2).pow(192)).mul(parseEther('1')).div(sqrtPriceX96.pow(2)) // usdl price like 1 usdl = 0.000555555555555555 weth per usdl output
    console.log('uniswapPrice: ', uniswapPrice.toString());

    // given target price mintPriceOnLemma, we need to calculate the optimum amount of collateral to swap
    // To come up with that number we are treating a uniswap V3 pool as a uniswap V2 pool and not really considering the fees
    // You should improve below to stay competitive

    const reserveCollateral = await collateral.balanceOf(uniswapV3PoolAddress);
    const reserveUSDL = await usdLemma.balanceOf(uniswapV3PoolAddress);
    // const pool = await ethers.getContractAt("IUniswapV3PoolState", uniswapV3PoolAddress);
    // getUniswapMarginalPrice(IUniswapV3Pool(pool));
    const k = reserveUSDL.mul(reserveCollateral);
    const temp = (k.mul(utils.parseEther("1")).div(mintPriceOnLemma));
    // console.dir(temp.toString())
    const targetUSDLReserves = sqrt(temp);
    console.log(`targetUSDLReserves=${targetUSDLReserves}`);

    const lpFees = BigNumber.from("3000");
    const loanFees = BigNumber.from("3000");
    const lpFeesMultiplier = BN1E6.div(BN1E6.sub(lpFees));
    const loanFeesMultiplier = BN1E6.div(BN1E6.sub(loanFees));

    let amountOfCollateralToBorrow;
    let amountOfUSDLToMint;
    let estimatedProfitMin;
    let estimatedProfitMax;

    //TODO:@nicola implement the logic for optimum amount below

    if (mintPriceOnLemma.lt(redeemPriceOnLemma)) {
        console.log(`WARNING: Arb within MCDex since mintPriceOnLemma=${mintPriceOnLemma} < redeemPriceOnLemma=${redeemPriceOnLemma}`);
        return [0, 0];
    }

    if (mintPriceOnLemma.gt(redeemPriceOnLemma) && uniswapPrice.gt(redeemPriceOnLemma) && uniswapPrice.lt(mintPriceOnLemma)) {
        console.log(`uniswapPrice in the Lemma Mint-Redeem Spread --> So no arb on Uniswap Possible\nuniswapPrice=${uniswapPrice}, mintPriceOnLemma=${mintPriceOnLemma}, redeemPriceOnLemma=${redeemPriceOnLemma}`);
        return [0, 0];
    }

    if (uniswapPrice.gt(mintPriceOnLemma)) {
        // Uniswap Price too high --> mint USDL and sell
        if (targetUSDLReserves.lt(reserveUSDL)) {
            console.log("WARNING: MintAndSell Arb Expected but not detected");
            // TODO: Manage this situation better
            return [0, 0];
        }

        console.log("Starting Mint and Sell");

        const estimatedExecutionPrice = estimateExecutionPriceOnPriceDelta(uniswapPrice, mintPriceOnLemma);
        console.log(`uniswapPrice=${uniswapPrice}, mintPriceOnLemma=${mintPriceOnLemma}, estimatedExecutionPrice=${estimatedExecutionPrice}`);

        amountOfUSDLToMint = targetUSDLReserves.sub(reserveUSDL);
        //const amountOfUSDLToMint = targetUSDLReserves - reserveUSDL;

        console.log(`targetUSDLReserves=${targetUSDLReserves}, reserveUSDL=${reserveUSDL}, amountOfUSDLToMint=${amountOfUSDLToMint}`);

        // Q: Does it include all the minting fees? 
        amountOfCollateralToBorrow = (amountOfUSDLToMint.mul(mintPriceOnLemma).div(utils.parseEther("1"))).mul(lpFeesMultiplier);
        const amountOwed = amountOfCollateralToBorrow.mul(loanFeesMultiplier);
        //const amountOfCollateralToBorrow = (amountOfUSDLToMint * mintPriceOnLemma / 1e18);

        //const estimatedWETHReturnMax = amountOfUSDLToMint.div(lpFeesMultiplier).mul(uniswapPrice).div(utils.parseEther("1"));
        const estimatedWETHReturn = amountOfUSDLToMint.div(lpFeesMultiplier).mul(estimatedExecutionPrice).div(utils.parseEther("1"));
        if (estimatedWETHReturn.lt(amountOwed)) {
            console.log("Mint and Sell Arb present but too small compared to the loan fees");
            return [0, 0];
        }

        estimatedProfit = estimatedWETHReturn.sub(amountOwed);
        //estimatedWETHReturn = amountOfUSDLToMint * uniswapPrice / 1e18;
    }

    if (uniswapPrice.lt(redeemPriceOnLemma)) {
        // Uniswap Price is too low --> buy USDL and redeem
        // Q: Should not we use the RedeemPrice here? 
        if (targetUSDLReserves.gt(reserveUSDL)) {
            console.log("WARNING: BuyAndRedeem Arb Expected but not detected");
            // TODO: Manage this situation better
            return [0, 0];
        }

        console.log("Starting Redeem and Buy");

        const estimatedExecutionPrice = estimateExecutionPriceOnPriceDelta(uniswapPrice, redeemPriceOnLemma);
        console.log(`uniswapPrice=${uniswapPrice}, redeemPriceOnLemma=${redeemPriceOnLemma}, estimatedExecutionPrice=${estimatedExecutionPrice}`);

        const amountOfUSDLToBuy = reserveUSDL.sub(targetUSDLReserves);

        console.log(`targetUSDLReserves=${targetUSDLReserves}, reserveUSDL=${reserveUSDL}, amountOfUSDLToBuy=${amountOfUSDLToBuy}`);

        amountOfCollateralToBorrow = (amountOfUSDLToBuy.mul(estimateExecutionPriceOnPriceDelta(uniswapPrice, redeemPriceOnLemma)).div(utils.parseEther("1"))).mul(lpFeesMultiplier);
        //amountOfCollateralToBorrow = (amountOfUSDLToBuy.mul(uniswapPrice).div(utils.parseEther("1"))).mul(lpFeesMultiplier);

        const amountOwed = amountOfCollateralToBorrow.mul(loanFeesMultiplier);

        const estimatedWETHReturn = amountOfUSDLToBuy.div(lpFeesMultiplier).mul(redeemPriceOnLemma).div(utils.parseEther("1"));

        if (estimatedWETHReturn.lt(amountOwed)) {
            console.log("Redeeem and Buy Arb present but too small compared to the loan fees");
            return [0, 0];
        }

        estimatedProfit = estimatedWETHReturn.sub(amountOwed);
        console.log(`estimatedWETHReturn=${estimatedWETHReturn}, amountOwed=${amountOwed}, estimatedProfit=${estimatedProfit}`);

        //this implementation is not
        // const k = reserveCollateral.mul(reserveUSDL);
        // const estimatedUSDLBuyPrice = reserveCollateral.mul(utils.parseEther("1")).div(reserveUSDL);
        // const temp = sqrt(k.mul(utils.parseEther("1")).div(mintPriceOnLemma));
        // const optimalUSDLAmountToMint = (reserveUSDL.sub(temp));//no consideration for the fees
        // const optimalAmountOfCollateralToBorrow = optimalUSDLAmountToMint.mul(utils.parseEther("1")).div(estimatedUSDLBuyPrice);

        // amountOfCollateralToBorrow = optimalAmountOfCollateralToBorrow;
        amountOfUSDLToMint = 0;//should be zero

    }

    console.log(`Arb Params: type=${amountOfUSDLToMint > 0 ? "MintAndSell" : "RedeemAndBuy"}, amountOfUSDLToMint=${amountOfUSDLToMint}, amountOfCollateralToBorrow=${amountOfCollateralToBorrow}, estimatedProfit=${estimatedProfit}`);
    // TODO: Get them from the pools
    return [amountOfCollateralToBorrow, amountOfUSDLToMint];
    // return [0, 0];
};

async function main() {
    try {
        [defaultSigner, user1, user2, user3, user4] = await ethers.getSigners();
        walletMnemonic = Wallet.fromMnemonic(process.env.MNEMONIC)
        const wallet = new Wallet(process.env.PRIVATE_KEY)
        const address = await wallet.getAddress()
        let signer = await ethers.provider.getSigner(address)
        console.log(`Your private key's address: `, address)

        const MainnetAddresses = {
            "USDLemma": "0xE026DBc8DDcdB4A919bAf811B03f32D39f4195C3",
            "MCDEXLemma": "0x65a8346B29486000F9C820D3f5eACb2a572D6893",
            "XUSDL": "0x5405b1F36D9FD253c07b8F1f17eD8320cE96b72A",
            "LemmaRouter": "0x4652548C20e52Dae9DfaF734F0a29803aaE91aA8",
            "UsdlWethUniV3Pair3000": "0xD1d0Af34dE781Ba2546D0F10e3f981983b1FBbA0",
            "WETH9": "0x207eD1742cc0BeBD03E50e855d3a14E41f93A461",
            "DAI": "0x8C0366c40801161A0375106fD3D9B29d4Fb9b918",
            "UniswapV3Factory": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
            "NonfungiblePositionManager": "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
            "SwapRouter": "0xE592427A0AEce92De3Edee1F18E0157C05861564",
            "ArbBot": "0xaB15A2BDfa5d210bdf1d8F5f023537DbE8De369c",
            "FlashLender": "0x6bdC1FCB2F13d1bA9D26ccEc3983d5D4bf318693", //DYDXERC3156 (borrows from dydx solo)
            "UniswapFlashLender": "0x6AE6E45522dE408087eA4Ca4864ed110b364542F"
        };

        this.uniswapV3Factory = new ethers.Contract(MainnetAddresses.UniswapV3Factory, IUniswapV3Factory.abi, defaultSigner);
        this.nonfungiblePositionManager = new ethers.Contract(MainnetAddresses.NonfungiblePositionManager, INonfungiblePositionManager.abi, signer);
        this.swapRouter = await ethers.getContractAt("ISwapRouter", MainnetAddresses.SwapRouter);
        this.weth = await ethers.getContractAt("IERC20", MainnetAddresses.WETH9);//is used as collateral
        this.collateral = this.weth;
        this.usdLemma = await ethers.getContractAt("IUSDLemma", MainnetAddresses.USDLemma);
        const perpetualDEXIndex = 0;
        const perpetualDEXWrapperAddress = await this.usdLemma.perpetualDEXWrappers(perpetualDEXIndex, this.collateral.address);
        this.perpetualDEXWrapper = await ethers.getContractAt("IPerpetualDEXWrapper", perpetualDEXWrapperAddress);

        await this.collateral.connect(signer).approve(this.usdLemma.address, MaxUint256);
        // approve nft
        console.log("Trying to approve NFT");
        await this.collateral.connect(signer).approve(this.nonfungiblePositionManager.address, MaxUint256);
        await this.usdLemma.connect(signer).approve(this.nonfungiblePositionManager.address, MaxUint256);
        console.log("NFT Approval Success");

        this.bot = await ethers.getContractAt("LemmaUniswapV3ArbBot", MainnetAddresses.ArbBot);
        console.log("Arb Bot Contract Deployment Success: ", this.bot.address);

        const [amountOfCollateralToBorrow, amountOfUSDLToMint] = await calculateOptimumWETHToBorrowAndUSDLToMint(signer, this.swapRouter, this.usdLemma, this.perpetualDEXWrapper, this.collateral, this.uniswapV3Factory, FeeAmount.MEDIUM);
        console.log("amountOfCollateralToBorrow", amountOfCollateralToBorrow.toString());
        console.log("amountOfUSDLToMint", amountOfUSDLToMint.toString());

        console.log('Calling arb function...')
        let tx = await this.bot.connect(signer).arb(amountOfCollateralToBorrow, amountOfUSDLToMint, {
            gasPrice: BigNumber.from('8000000000'),
            gasLimit: BigNumber.from('9000000')
        });
        await tx.wait();
        await printTx(tx.hash);

    } catch (error) {
        console.log('Error', error)
    }
}

main()
