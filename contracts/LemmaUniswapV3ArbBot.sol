// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.7.6;
pragma abicoder v2;

import '@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol';
import '@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

import './interfaces/IPerpetualDEXWrapper.sol';
import './interfaces/IUSDLemma.sol';

import 'erc3156/contracts/interfaces/IERC3156FlashBorrower.sol';
import 'erc3156/contracts/interfaces/IERC3156FlashLender.sol';

import 'hardhat/console.sol';

//WETH is first added now but it can be any collateral in the future

/**Purpose of this contract is to take adavatage of arbitrage opportunity explained here: https://lemma-support.gitbook.io/lemma/concepts-overview/usdl-price-stability
    on Uinswap V3 Pools.
*/
contract LemmaUniswapV3ArbBot is IERC3156FlashBorrower {
    //USDL specific addresses
    IPerpetualDEXWrapper public immutable lemmaPerpDEXWrapper;
    IUSDLemma public immutable usdLemma;
    uint256 public immutable perpetualDEXIndex;

    //collateral address = WETH for now
    IERC20 public immutable collateral;

    ISwapRouter public immutable swapRouter;
    uint24 public immutable poolFee;

    //the flashloan provider address
    IERC3156FlashLender public immutable flashLender;
    bytes32 public constant CALLBACK_SUCCESS =
        keccak256('ERC3156FlashBorrower.onFlashLoan');

    struct FlashCallbackData {
        uint256 amountOfUSDLToMint;
    }

    constructor(
        IERC20 _collateral,
        uint256 _perpetualDEXIndex,
        IUSDLemma _usdLemma,
        uint24 _poolFee,
        ISwapRouter _swapRouter,
        IERC3156FlashLender _flashLender
    ) {
        collateral = _collateral;
        usdLemma = _usdLemma;
        perpetualDEXIndex = _perpetualDEXIndex;
        poolFee = _poolFee;
        swapRouter = _swapRouter;
        flashLender = _flashLender;
        lemmaPerpDEXWrapper = IPerpetualDEXWrapper(
            _usdLemma.perpetualDEXWrappers(
                _perpetualDEXIndex,
                address(_collateral)
            )
        );
        //approve to flashLender
        TransferHelper.safeApprove(
            address(_collateral),
            address(_flashLender),
            type(uint256).max
        );
        //approve collateral to USDLemma
        TransferHelper.safeApprove(
            address(_collateral),
            address(_usdLemma),
            type(uint256).max
        );
        //approve collateral to swap Router
        TransferHelper.safeApprove(
            address(_collateral),
            address(_swapRouter),
            type(uint256).max
        );
        //approve USDL to swap Router
        TransferHelper.safeApprove(
            address(_usdLemma),
            address(_swapRouter),
            type(uint256).max
        );
    }

    /**
     * @dev Receive a flash loan.
     * @param initiator The initiator of the loan.
     * @param token The loan currency.
     * @param amount The amount of tokens lent.
     * @param fee The additional amount of tokens to repay.
     * @param data Arbitrary data structure, intended to contain user-defined parameters.
     * @return The keccak256 hash of "ERC3156FlashBorrower.onFlashLoan"
     */
    function onFlashLoan(
        address initiator,
        address token, //token = collateral
        uint256 amount,
        uint256 fee,
        bytes calldata data
    ) external override returns (bytes32) {
        require(
            initiator == address(this),
            'FlashBorrower: External loan initiator'
        );
        require(token == address(collateral), 'wrong token borrowed');
        FlashCallbackData memory flashCallBackData = abi.decode(
            data,
            (FlashCallbackData)
        );
        uint256 amountOfUSDLToMint = flashCallBackData.amountOfUSDLToMint;
        if (amountOfUSDLToMint > 0) {
            //1. mint USDL
            //2. sell USDL for collateral

            //if amountOfUSDLToMint > 0  then it means uniswap price > Lemma mint price
            //mint USDL

            //cost of minting USDL
            //should come out to be less than the amount of collateral lent
            uint256 amountOfCollteralCost = lemmaPerpDEXWrapper
                .getCollateralAmountGivenUnderlyingAssetAmount(
                    amountOfUSDLToMint,
                    true
                );
            usdLemma.deposit(
                amountOfUSDLToMint,
                perpetualDEXIndex,
                type(uint256).max,
                collateral
            );
            //swap minted USDL back for collateral (>1$ price)
            uint256 returnedCollateral = swapRouter.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: address(usdLemma),
                    tokenOut: address(collateral),
                    fee: poolFee,
                    recipient: address(this),
                    deadline: block.timestamp + 200,
                    amountIn: amountOfUSDLToMint,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
            require(
                amountOfCollteralCost + fee <= returnedCollateral,
                'arb not profitable'
            );
        } else {
            //1.buy USDL using collateral
            //2.redeem USDL
            //if mintOrRedeem = false then it means uniswap price < Lemma mint price
            //buy USDL on uniswap V3 pool (<1$ price)
            uint256 returnedUSDL = swapRouter.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: address(collateral),
                    tokenOut: address(usdLemma),
                    fee: poolFee,
                    recipient: address(this),
                    deadline: block.timestamp + 200,
                    amountIn: amount, //amount borrowed
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
            //redeem that much amount of USDL for collateral on lemma
            uint256 amountOfCollteralToGetBack = lemmaPerpDEXWrapper
                .getCollateralAmountGivenUnderlyingAssetAmount(
                    returnedUSDL,
                    false
                );
            usdLemma.withdraw(returnedUSDL, perpetualDEXIndex, 0, collateral);
            require(
                amount + fee <= amountOfCollteralToGetBack,
                'arb not profitable'
            );
        }
        return CALLBACK_SUCCESS;
    }

    /** When Arbitrage opportuanity is detected offchain client needs to calculate whether
        to buy or sell USDL on uniswap V3 pool and how much.
        minting/redeeming price for USDL can be asuumed to be almost a constant 1$ worth of ETH for the purpose of calculating arbitrage opportunities.
        So, the optimisation in calculating how much collateral to borrow to buy/sell USDL would result in maximum profit.
        Given amountOfCollateralToBorrow, off-chain also needs to calculation amountOfUSDLToMint if minting is required to sell the USDL. Otherwise amountOfUSDLToMint would be 0.
        see this discussion on how to caluclate amountOfUSDLToMint given amountOfCollateralToBorrow for MCDEX. https://forum.mcdex.io/t/leverage-token-based-on-mcdex-perpetual-mai3/380/6?u=yashnaman
        or see the reference implemention in scripts/TODO:.
    */
    function arb(uint256 amountOfCollateralToBorrow, uint256 amountOfUSDLToMint)
        external
    {
        flashLender.flashLoan(
            IERC3156FlashBorrower(address(this)),
            address(collateral),
            amountOfCollateralToBorrow,
            abi.encode(
                FlashCallbackData({amountOfUSDLToMint: amountOfUSDLToMint})
            )
        );
        //send the profits to the caller
        collateral.transfer(msg.sender, collateral.balanceOf(address(this)));
    }
}
