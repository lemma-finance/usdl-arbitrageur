const bn = require('bignumber.js');
const { BigNumber } = require('ethers');
bn.config({ EXPONENTIAL_AT: 999999, DECIMAL_PLACES: 40 });

const MaxUint128 = BigNumber.from(2).pow(128).sub(1);

const FeeAmount = {
    LOW: 500,
    MEDIUM: 3000,
    HIGH: 10000,
};

const TICK_SPACINGS = {
    [FeeAmount.LOW]: 10,
    [FeeAmount.MEDIUM]: 60,
    [FeeAmount.HIGH]: 200,
};

// returns the sqrt price as a 64x96
function encodePriceSqrt(reserve1, reserve0) {
    return BigNumber.from(
        new bn(reserve1.toString())
            .div(reserve0.toString())
            .sqrt()
            .multipliedBy(new bn(2).pow(96))
            .integerValue(3)
            .toString()
    );
}


const getMinTick = (tickSpacing) => Math.ceil(-887272 / tickSpacing) * tickSpacing;
const getMaxTick = (tickSpacing) => Math.floor(887272 / tickSpacing) * tickSpacing;
const getMaxLiquidityPerTick = (tickSpacing) =>
    BigNumber.from(2)
        .pow(128)
        .sub(1)
        .div((getMaxTick(tickSpacing) - getMinTick(tickSpacing)) / tickSpacing + 1);

module.exports = { getMaxLiquidityPerTick, getMaxTick, getMinTick, encodePriceSqrt, TICK_SPACINGS, FeeAmount };
