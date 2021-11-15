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



// Use to compute percentages
const BN1E6 = BigNumber.from("1000000");

/**
 * This function should estimate the real execution price given from marginal price and the amount 
 * Currently there is only a trivial implementation considering a fixed amount of slippage but with UniswapV3 it actually depends on the specific shape of the curve which is non trivial to estimate because of concentrate liquidity
 * @param {BigNumber} marginalPrice 
 * @param {BigNumber} targetPrice
 */
function estimateExecutionPriceOnPriceDelta(marginalPrice, targetPrice) {
    return (marginalPrice.add(targetPrice)).div(BigNumber.from("2"));
}
//This is just a reference to which works but is not the most efficient way to do it
//You should improve this to be stay competitive with the other bots
const calculateOptimumWETHToBorrowAndUSDLToMint = async (defaultSigner, swapRouter, usdLemma, perpetualDEXWrapper, collateral, uniswapV3Factory, poolFee) => {

    //get mint price for 1 USDL
    //assume this as the target price
    const mintPriceOnLemma = await perpetualDEXWrapper.callStatic.getCollateralAmountGivenUnderlyingAssetAmount(utils.parseEther("1"), true);

    const redeemPriceOnLemma = mintPriceOnLemma;
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

    //given target price mintPriceOnLemma, we need to calculate the optimum amount of collateral to swap
    //To come up with that number we are treating a uniswap V3 pool as a uniswap V2 pool and not really considering the fees
    //You should improve below to stay competitive

    const uniswapV3PoolAddress = await uniswapV3Factory.getPool(collateral.address, usdLemma.address, poolFee);
    const reserveCollateral = await collateral.balanceOf(uniswapV3PoolAddress);
    const reserveUSDL = await usdLemma.balanceOf(uniswapV3PoolAddress);
    const k = reserveUSDL.mul(reserveCollateral);
    const temp = (k.mul(utils.parseEther("1")).div(mintPriceOnLemma));
    const targetUSDLReserves = sqrt(temp);

    const lpFees = BigNumber.from("3000");
    const lpFeesMultiplier = BN1E6.div(BN1E6.sub(lpFees));

    let amountOfCollateralToBorrow;
    let amountOfUSDLToMint;

    if (uniswapPrice.gt(mintPriceOnLemma)) {
        // Uniswap Price too high --> mint USDL and sell
        if (targetUSDLReserves.lt(reserveUSDL)) {
            console.log("WARNING: MintAndSell Arb Expected but not detected");
            return [0, 0];
        }
        const estimatedExecutionPrice = estimateExecutionPriceOnPriceDelta(uniswapPrice, mintPriceOnLemma);
        amountOfUSDLToMint = targetUSDLReserves.sub(reserveUSDL);
        // lazy calculations (needs improvement)
        amountOfCollateralToBorrow = (amountOfUSDLToMint.mul(mintPriceOnLemma).div(utils.parseEther("1"))).mul(lpFeesMultiplier);
    }

    if (uniswapPrice.lt(redeemPriceOnLemma)) {
        // Uniswap Price is too low --> buy USDL and redeem
        if (targetUSDLReserves.gt(reserveUSDL)) {
            console.log("WARNING: BuyAndRedeem Arb Expected but not detected");
            // TODO: Manage this situation better
            return [0, 0];
        }
        const amountOfUSDLToBuy = reserveUSDL.sub(targetUSDLReserves);
        amountOfCollateralToBorrow = (amountOfUSDLToBuy.mul(estimateExecutionPriceOnPriceDelta(uniswapPrice, redeemPriceOnLemma)).div(utils.parseEther("1"))).mul(lpFeesMultiplier);
        amountOfUSDLToMint = 0;//should be zero

    }
    return [amountOfCollateralToBorrow, amountOfUSDLToMint];
};

describe('LemmaRouter', function () {
    let lemmaAddresses;
    const poolFee = FeeAmount.MEDIUM;
    const MainnetAddresses = {
        "WETH9": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "UniswapV3Factory": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "NonfungiblePositionManager": "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
        "SwapRouter": "0xE592427A0AEce92De3Edee1F18E0157C05861564",
        "FlashLender": "0x6bdC1FCB2F13d1bA9D26ccEc3983d5D4bf318693"//DYDXERC3156 (borrows from dydx solo)
    };
    const ZERO = BigNumber.from("0");

    before(async function () {
        [defaultSigner, user1, user2, user3, user4] = await ethers.getSigners();
        lemmaAddresses = await loadLemmaInfo();

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

        //get some weth (collateral) and usdl
        // await user3.sendTransaction({ to: defaultSigner.address, value: utils.parseEther("5000") });//just so that default signer does not run out
        // await defaultSigner.sendTransaction({ to: this.weth.address, value: utils.parseEther("1000") });

        //mint USDL
        amountMintUSDL = "250000";
        const amount = utils.parseEther(amountMintUSDL);
        await this.collateral.approve(this.usdLemma.address, MaxUint256);
        await this.usdLemma.deposit(amount, 0, MaxUint256, this.collateral.address);

        // approve nft
        await this.collateral.approve(this.nonfungiblePositionManager.address, MaxUint256);
        await this.usdLemma.approve(this.nonfungiblePositionManager.address, MaxUint256);

        const LemmaUniswapV3ArbBot = await ethers.getContractFactory("LemmaUniswapV3ArbBot");
        this.bot = await LemmaUniswapV3ArbBot.deploy(
            this.collateral.address,
            perpetualDEXIndex,
            this.usdLemma.address,
            poolFee,
            this.swapRouter.address,
            MainnetAddresses.FlashLender
        );
    });

    beforeEach(async function () {
        snapshotId = await snapshot();
    });
    afterEach(async function () {
        await revertToSnapshot(snapshotId);
    });
    it("should initialize correctly", async function () {
        expect(await this.bot.swapRouter()).to.equal(this.swapRouter.address);//etc
        expect(await this.bot.collateral()).to.equal(MainnetAddresses.WETH9);
        expect(await this.bot.usdLemma()).to.equal(lemmaAddresses.USDLemma.address);
        expect(await this.bot.poolFee()).to.equal(BigNumber.from(poolFee));
        expect(await this.bot.flashLender()).to.equal(MainnetAddresses.FlashLender);
        expect(await this.bot.lemmaPerpDEXWrapper()).to.equal(this.perpetualDEXWrapper.address);
        expect(await this.bot.perpetualDEXIndex()).to.equal(ZERO);
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

            const mintPriceOnLemmaBefore = await this.perpetualDEXWrapper.callStatic.getCollateralAmountGivenUnderlyingAssetAmount(utils.parseEther("1"), true);
            const uniswapPriceBefore = utils.parseEther("100").mul(utils.parseEther("1")).div(utils.parseEther("250000"));
            const differenceBefore = uniswapPriceBefore.sub(mintPriceOnLemmaBefore);

            const [amountOfCollateralToBorrow, amountOfUSDLToMint] = await calculateOptimumWETHToBorrowAndUSDLToMint(defaultSigner, this.swapRouter, this.usdLemma, this.perpetualDEXWrapper, this.collateral, this.uniswapV3Factory, FeeAmount.MEDIUM);
            let tx = await this.bot.arb(amountOfCollateralToBorrow, 0);
            await tx.wait();
            // await printTx(tx.hash);


            //@dev here this is an unefficient way of reading the uniswap price 
            const exactInputSingleParams = {
                tokenIn: this.usdLemma.address,
                tokenOut: this.collateral.address,
                fee: poolFee,
                recipient: defaultSigner.address,
                deadline: MaxUint256,
                amountIn: utils.parseEther("1"),
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0,
            };

            await this.usdLemma.approve(this.swapRouter.address, MaxUint256);

            // NOTE: We need this to be the price to buy 1e18 USDL, expressed in WETH
            const mintPriceOnLemmaAfter = await this.perpetualDEXWrapper.callStatic.getCollateralAmountGivenUnderlyingAssetAmount(utils.parseEther("1"), true);
            const uniswapPriceAfter = await this.swapRouter.callStatic.exactInputSingle(exactInputSingleParams);

            const differenceAfter = uniswapPriceAfter.sub(mintPriceOnLemmaAfter);
            expect(differenceAfter.abs()).to.be.lt(differenceBefore.abs());

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


            const mintPriceOnLemmaBefore = await this.perpetualDEXWrapper.callStatic.getCollateralAmountGivenUnderlyingAssetAmount(utils.parseEther("1"), true);
            const uniswapPriceBefore = utils.parseEther("100").mul(utils.parseEther("1")).div(utils.parseEther("180000"));
            const differenceBefore = uniswapPriceBefore.sub(mintPriceOnLemmaBefore);


            //optimum amount of USDL to buy and redeem
            const [amountOfCollateralToBorrow, amountOfUSDLToMint] = await calculateOptimumWETHToBorrowAndUSDLToMint(defaultSigner, this.swapRouter, this.usdLemma, this.perpetualDEXWrapper, this.collateral, this.uniswapV3Factory, FeeAmount.MEDIUM);

            let tx = await this.bot.arb(amountOfCollateralToBorrow, amountOfUSDLToMint);
            await tx.wait();
            // await printTx(tx.hash);


            //@dev here this is an unefficient way of reading the uniswap price 
            const exactInputSingleParams = {
                tokenIn: this.usdLemma.address,
                tokenOut: this.collateral.address,
                fee: poolFee,
                recipient: defaultSigner.address,
                deadline: MaxUint256,
                amountIn: utils.parseEther("1"),
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0,
            };

            await this.usdLemma.approve(this.swapRouter.address, MaxUint256);

            // NOTE: We need this to be the price to buy 1e18 USDL, expressed in WETH
            const mintPriceOnLemmaAfter = await this.perpetualDEXWrapper.callStatic.getCollateralAmountGivenUnderlyingAssetAmount(utils.parseEther("1"), true);
            const uniswapPriceAfter = await this.swapRouter.callStatic.exactInputSingle(exactInputSingleParams);

            const differenceAfter = uniswapPriceAfter.sub(mintPriceOnLemmaAfter);
            expect(differenceAfter.abs()).to.be.lt(differenceBefore.abs());
        });
    });

});