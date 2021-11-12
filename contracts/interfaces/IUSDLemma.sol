// SPDX-License-Identifier: MIT
pragma solidity ^0.7.6;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

interface IUSDLemma is IERC20 {
    function deposit(
        uint256 amount,
        uint256 perpetualDEXIndex,
        uint256 maxCollateralRequired,
        IERC20 collateral
    ) external;

    function withdraw(
        uint256 amount,
        uint256 perpetualDEXIndex,
        uint256 minCollateralToGetBack,
        IERC20 collateral
    ) external;

    function perpetualDEXWrappers(uint256 perpetualDEXIndex, address collateral)
        external
        view
        returns (address);
}
