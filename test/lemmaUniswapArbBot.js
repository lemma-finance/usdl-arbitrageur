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

const calculateOptimumWETHToBorrowAndUSDLToMint = async (defaultSigner, swapRouter, usdLemma, perpetualDEXWrapper, collateral, uniswapV3Factory, poolFee) => {

    //get mint price for 1 USDL
    //assume this as the target price
    const mintPriceOnLemma = await perpetualDEXWrapper.callStatic.getCollateralAmountGivenUnderlyingAssetAmount(utils.parseEther("1"), true);
    console.log("mintPriceOnLemma", mintPriceOnLemma.toString());

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

    const uniswapPrice = await swapRouter.callStatic.exactInputSingle(exactInputSingleParams);
    console.log("uniswap Price", uniswapPrice.toString());

    //given target price mintPriceOnLemma, we need to calculate the optimum amount of collateral to swap
    //To come up with that number we are treating a uniswap V3 pool as a uniswap V2 pool and not really considering the fees
    //You should improve below to stay competitive

    const uniswapV3PoolAddress = await uniswapV3Factory.getPool(collateral.address, usdLemma.address, poolFee);
    const reserveCollateral = await collateral.balanceOf(uniswapV3PoolAddress);
    const reserveUSDL = await usdLemma.balanceOf(uniswapV3PoolAddress);


    let amountOfCollateralToBorrow;
    let amountOfUSDLToMint;
    //TODO:@nicola implement the logic for optimum amount below
    if (uniswapPrice.gt(mintPriceOnLemma)) {
        //mint USDL and sell


    }
    else {
        //buy USDL and redeem

        //this implementation is not
        // const k = reserveCollateral.mul(reserveUSDL);
        // const estimatedUSDLBuyPrice = reserveCollateral.mul(utils.parseEther("1")).div(reserveUSDL);
        // const temp = sqrt(k.mul(utils.parseEther("1")).div(mintPriceOnLemma));
        // const optimalUSDLAmountToMint = (reserveUSDL.sub(temp));//no consideration for the fees
        // const optimalAmountOfCollateralToBorrow = optimalUSDLAmountToMint.mul(utils.parseEther("1")).div(estimatedUSDLBuyPrice);

        // amountOfCollateralToBorrow = optimalAmountOfCollateralToBorrow;
        amountOfUSDLToMint = 0;//should be zero

    }
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
        const amount = utils.parseEther("250000");
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
        });
    });

});