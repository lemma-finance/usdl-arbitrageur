const { JsonRpcProvider } = require('@ethersproject/providers');
const { ethers } = require("hardhat");
const { expect, util } = require("chai");
const { utils } = require('ethers');
const { BigNumber, constants } = ethers;
const { AddressZero, MaxUint256, MaxInt256 } = constants;

const { loadLemmaInfo, snapshot, revertToSnapshot, doRequest, replaceAll, tokenTransfers, sqrt } = require("./utils");
const { TICK_SPACINGS, FeeAmount, encodePriceSqrt, getMaxTick, getMinTick } = require("./uniswapUtils");

const INonfungiblePositionManager = require("@uniswap/v3-periphery/artifacts/contracts/interfaces/INonfungiblePositionManager.sol/INonfungiblePositionManager.json");
const IUniswapV3Factory = require("@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json");
const IUniswapV3Pool = require("@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json");
const IUniswapV3PoolState = require("@uniswap/v3-core/artifacts/contracts/interfaces/pool/IUniswapV3PoolState.sol/IUniswapV3PoolState.json");

const printTx = async (hash) => {
    await tokenTransfers.print(hash, [], false);
};

async function mineBlocks(blockNumber) {
    while (blockNumber > 0) {
        blockNumber--;
        await hre.network.provider.request({
            method: "evm_mine",
            params: [],
        });
    }
}


/*
function getUniswapMarginalPrice(pool) {
    res = pool.callStatic.slot0();
    console.dir(res);
    //slot.uniswap_X_WETH_for_1E18_USDL =  (uint256(sqrtPriceX96) ** 2) * 1e18 / (2 ** 192);
    return 0;
}
*/

// Use to compute percentages
const BN1E6 = BigNumber.from("1000000");


/**
 * This function should estimate the real execution price given from marginal price and the amount 
 * Currently there is only a trivial implementation considering a fixed amount of slippage but with UniswapV3 it actually depends on the specific shape of the curve which is non trivial to estimate because of concentrate liquidity
 * @param {BigNumber} marginalPrice 
 * @param {BigNumber} amount 
 * @param {Int: 0,1} direction: 0 = Sell, 1 = Buy
 */
function estimateExecutionPrice(marginalPrice, amount, direction) {
    // Considering a max 2% slippage
    const maxSlippage = BigNumber.from("20000");
    if (direction == 0) {
        // Sell --> Slippage reduce the price 
        return marginalPrice.mul(BN1E6.div(BN1E6.add(maxSlippage)));
    }
    else if(direction == 1) {
        // Buy --> Slippage increases the price
        return marginalPrice.mul((BN1E6.add(maxSlippage)).div(BN1E6));
    }
    return 0;
}

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

    //@dev here this is an unefficient way of reading the uniswap price 
    const exactInputSingleParams = {
        tokenIn: usdLemma.address,
        tokenOut: collateral.address,
        fee: poolFee,
        recipient: defaultSigner.address,
        deadline: MaxUint256,
        amountIn: utils.parseEther("1"),
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
    };
    await usdLemma.approve(swapRouter.address, MaxUint256);

    // NOTE: We need this to be the price to buy 1e18 USDL, expressed in WETH
    const uniswapPrice = await swapRouter.callStatic.exactInputSingle(exactInputSingleParams);
    console.log("uniswap Price", uniswapPrice.toString());


    //given target price mintPriceOnLemma, we need to calculate the optimum amount of collateral to swap
    //To come up with that number we are treating a uniswap V3 pool as a uniswap V2 pool and not really considering the fees
    //You should improve below to stay competitive

    const uniswapV3PoolAddress = await uniswapV3Factory.getPool(collateral.address, usdLemma.address, poolFee);
    const reserveCollateral = await collateral.balanceOf(uniswapV3PoolAddress);
    const reserveUSDL = await usdLemma.balanceOf(uniswapV3PoolAddress);
    //const pool = await ethers.getContractAt("IUniswapV3PoolState", uniswapV3PoolAddress); 
    //getUniswapMarginalPrice(IUniswapV3Pool(pool));
    const k = reserveUSDL.mul(reserveCollateral);
    const temp = (k.mul(utils.parseEther("1")).div(mintPriceOnLemma));
    //console.dir(temp)
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
        return [0,0];
    }

    if (mintPriceOnLemma.gt(redeemPriceOnLemma) && uniswapPrice.gt(redeemPriceOnLemma) && uniswapPrice.lt(mintPriceOnLemma)) {
        console.log(`uniswapPrice in the Lemma Mint-Redeem Spread --> So no arb on Uniswap Possible\nuniswapPrice=${uniswapPrice}, mintPriceOnLemma=${mintPriceOnLemma}, redeemPriceOnLemma=${redeemPriceOnLemma}`);
        return [0,0];
    }

    if (uniswapPrice.gt(mintPriceOnLemma)) {
        // Uniswap Price too high --> mint USDL and sell
        if (targetUSDLReserves.lt(reserveUSDL)) {
            console.log("WARNING: MintAndSell Arb Expected but not detected");
            // TODO: Manage this situation better
            return [0,0];
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
            return [0,0];
        }

        estimatedProfit = estimatedWETHReturn.sub(amountOwed);
        //estimatedWETHReturn = amountOfUSDLToMint * uniswapPrice / 1e18;
    }

    if(uniswapPrice.lt(redeemPriceOnLemma)) {
        // Uniswap Price is too low --> buy USDL and redeem
        // Q: Should not we use the RedeemPrice here? 
        if (targetUSDLReserves.gt(reserveUSDL)) {
            console.log("WARNING: BuyAndRedeem Arb Expected but not detected");
            // TODO: Manage this situation better
            return [0,0];
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
            return [0,0];
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
};

describe('LemmaRouter', function () {
    let lemmaAddresses;

    const poolFee = FeeAmount.MEDIUM;

    before(async function () {
        [defaultSigner, user1, user2, user3, user4] = await ethers.getSigners();
        lemmaAddresses = await loadLemmaInfo();
        const MainnetAddresses = {
            "WETH9": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            "UniswapV3Factory": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
            "NonfungiblePositionManager": "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
            "SwapRouter": "0xE592427A0AEce92De3Edee1F18E0157C05861564",
            "FlashLender": "0x6bdC1FCB2F13d1bA9D26ccEc3983d5D4bf318693"//DYDXERC3156 (borrows from dydx solo)
        };
        //set up uniswap USDL-collateral pool (collateral = WETH)

        this.uniswapV3Factory = new ethers.Contract(MainnetAddresses.UniswapV3Factory, IUniswapV3Factory.abi, defaultSigner);
        this.nonfungiblePositionManager = new ethers.Contract(MainnetAddresses.NonfungiblePositionManager, INonfungiblePositionManager.abi, defaultSigner);


        this.swapRouter = await ethers.getContractAt("ISwapRouter", MainnetAddresses.SwapRouter);
        this.weth = await ethers.getContractAt("IERC20", MainnetAddresses.WETH9);//is used as collateral
        this.collateral = this.weth;
        this.usdLemma = await ethers.getContractAt("IUSDLemma", lemmaAddresses.USDLemma.address);

        const perpetualDEXIndex = 0;
        const perpetualDEXWrapperAddress = await this.usdLemma.perpetualDEXWrappers(perpetualDEXIndex, this.collateral.address);

        this.perpetualDEXWrapper = await ethers.getContractAt("IPerpetualDEXWrapper", perpetualDEXWrapperAddress);

        console.log("in");

        //get some weth (collateral) and usdl
        // await user3.sendTransaction({ to: defaultSigner.address, value: utils.parseEther("5000") });//just so that default signer does not run out
        // await defaultSigner.sendTransaction({ to: this.weth.address, value: utils.parseEther("1000") });

        //mint USDL
        amountMintUSDL = "250000";
        console.log(`Trying to mint ${amountMintUSDL} USDL`);
        const amount = utils.parseEther(amountMintUSDL);
        await this.collateral.approve(this.usdLemma.address, MaxUint256);
        await this.usdLemma.deposit(amount, 0, MaxUint256, this.collateral.address);
        console.log("USDL Minting Success");

        // approve nft
        console.log("Trying to approve NFT");
        await this.collateral.approve(this.nonfungiblePositionManager.address, MaxUint256);
        await this.usdLemma.approve(this.nonfungiblePositionManager.address, MaxUint256);
        console.log("NFT Approval Success");

        console.log("Trying to deploy ArbBot Contract");
        const LemmaUniswapV3ArbBot = await ethers.getContractFactory("LemmaUniswapV3ArbBot");
        this.bot = await LemmaUniswapV3ArbBot.deploy(
            this.collateral.address,
            perpetualDEXIndex,
            this.usdLemma.address,
            poolFee,
            this.swapRouter.address,
            MainnetAddresses.FlashLender
        );
        console.log("Arb Bot Contract Deployment Success");
    });

    beforeEach(async function () {
        snapshotId = await snapshot();
    });
    afterEach(async function () {
        await revertToSnapshot(snapshotId);
    });
    it("should initialize correctly", async function () {
    });
    describe("should arb correctly", async function () {
        it("when uniswap price is >1$", async function () {
            // Initialize pool
            await this.nonfungiblePositionManager.createAndInitializePoolIfNecessary(
                this.usdLemma.address,
                this.collateral.address,
                FeeAmount.MEDIUM,
                encodePriceSqrt(1, 2500)////on lemma price is 2000
            );

            // Initial add liquidity in Uniswap for 3000 Fees
            const liquidityParams = {
                token0: this.usdLemma.address,
                token1: this.collateral.address,
                tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
                tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
                fee: FeeAmount.MEDIUM,
                recipient: defaultSigner.address,
                amount0Desired: utils.parseEther("250000"),
                amount1Desired: utils.parseEther("100"),
                amount0Min: 0,
                amount1Min: 0,
                deadline: MaxUint256,
            };
            await this.nonfungiblePositionManager.mint(liquidityParams);

            const [amountOfCollateralToBorrow, amountOfUSDLToMint] = await calculateOptimumWETHToBorrowAndUSDLToMint(defaultSigner, this.swapRouter, this.usdLemma, this.perpetualDEXWrapper, this.collateral, this.uniswapV3Factory, FeeAmount.MEDIUM);
            let tx = await this.bot.arb(utils.parseEther("1"), 0);
            await tx.wait();
            await printTx(tx.hash);

            /*
            //@dev here this is an unefficient way of reading the uniswap price 
            const exactInputSingleParams = {
                tokenIn: usdLemma.address,
                tokenOut: collateral.address,
                fee: poolFee,
                recipient: defaultSigner.address,
                deadline: MaxUint256,
                amountIn: utils.parseEther("1"),
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0,
            };
            
            await this.usdLemma.approve(this.swapRouter.address, MaxUint256);

            // NOTE: We need this to be the price to buy 1e18 USDL, expressed in WETH
            const uniswapPrice = await this.swapRouter.callStatic.exactInputSingle(exactInputSingleParams);
            console.log("[AfterTrade] uniswap Price", uniswapPrice.toString());
            */
        });
        it("when uniswap price is <1$", async function () {
            // Initialize pool
            await this.nonfungiblePositionManager.createAndInitializePoolIfNecessary(
                this.usdLemma.address,
                this.collateral.address,
                FeeAmount.MEDIUM,
                encodePriceSqrt(1, 1800) //on lemma price is 2000
            );

            // Initial add liquidity in Uniswap for 3000 Fees
            const liquidityParams = {
                token0: this.usdLemma.address,
                token1: this.collateral.address,
                tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
                tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
                fee: FeeAmount.MEDIUM,
                recipient: defaultSigner.address,
                amount0Desired: utils.parseEther("180000"),
                amount1Desired: utils.parseEther("100"),
                amount0Min: 0,
                amount1Min: 0,
                deadline: MaxUint256,
            };
            await this.nonfungiblePositionManager.mint(liquidityParams);

            //optimum amount of USDL to buy and redeem
            const [amountOfCollateralToBorrow, amountOfUSDLToMint] = await calculateOptimumWETHToBorrowAndUSDLToMint(defaultSigner, this.swapRouter, this.usdLemma, this.perpetualDEXWrapper, this.collateral, this.uniswapV3Factory, FeeAmount.MEDIUM);

            let tx = await this.bot.arb(utils.parseEther("1"), utils.parseEther("1").mul(BigNumber.from("1800")));
            await tx.wait();
            await printTx(tx.hash);

            /*
            //@dev here this is an unefficient way of reading the uniswap price 
            const exactInputSingleParams = {
                tokenIn: usdLemma.address,
                tokenOut: collateral.address,
                fee: poolFee,
                recipient: defaultSigner.address,
                deadline: MaxUint256,
                amountIn: utils.parseEther("1"),
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0,
            };
            
            await this.usdLemma.approve(this.swapRouter.address, MaxUint256);

            // NOTE: We need this to be the price to buy 1e18 USDL, expressed in WETH
            const uniswapPrice = await this.swapRouter.callStatic.exactInputSingle(exactInputSingleParams);
            console.log("[AfterTrade] uniswap Price", uniswapPrice.toString());
            */
                });
            });
            
});