var colors = require('colors');
const fs = require("fs");
const hre = require("hardhat");
const { BigNumber } = hre.ethers;
const { utils } = require('ethers');

const util = require('util');
const exec = util.promisify(require('child_process').exec);
const bn = require("bignumber.js");
const tokenTransfers = require("truffle-token-test-utils");
tokenTransfers.setCurrentProvider(hre.network.config.url);
const request = require('request');

const deployMCDEXLocally = async function () {
    // console.log("deploying MCDEX locally,please wait...");
    const { stdout, stderr } = await exec("cd basis-trading-stablecoin/mai-protocol-v3/ && pwd && npx hardhat run scripts/deploy.ts --network local && cd ../../  && pwd");
    if (stderr) {
        console.error(`error: ${stderr}`);
    }
    // console.log(`output: ${stdout}`);
    // console.log("deployment done");
};

const deployLemmaLocally = async function () {
    console.log("deploying Lemma locally,please wait...");
    const { stdout, stderr } = await exec("cd basis-trading-stablecoin/ && pwd && npx hardhat run scripts/deploy_local.js --network local && cd ..  && pwd");
    if (stderr) {
        console.error(`error: ${stderr}`);
    }
    console.log(`output: ${stdout}`);
    console.log("deployment done");
};


const loadMCDEXInfo = async function () {
    //deploy mcdex and then load
    await deployMCDEXLocally();
    //get MCDEXAddresses
    const data = fs.readFileSync(__dirname + '/../basis-trading-stablecoin/mai-protocol-v3/deployments/local.deployment.js', 'utf8');
    return JSON.parse(data);
};


const loadLemmaInfo = async function () {

    await deployLemmaLocally();

    const data = fs.readFileSync(__dirname + '/../basis-trading-stablecoin/deployments/local.deployment.js', 'utf8');
    return JSON.parse(data);

};


const toBigNumber = (amount) => {
    const amountBN = new bn(amount.toString());
    const ONE = new bn(utils.parseEther("1").toString());
    return amountBN.div(ONE);
};
const fromBigNumber = (amount) => {
    const ONE = new bn(utils.parseEther("1").toString());
    const amountInWei = (amount.times(ONE)).integerValue(); //ignore after 18 decimals
    return BigNumber.from(amountInWei.toString());
};
function sqrt(value) {
    return BigNumber.from(new bn(value.toString()).sqrt().toFixed().split('.')[0]);
}
const rpcCall = async (callType, params) => {
    return await hre.network.provider.request({
        method: callType,
        params: params
    });
};
const snapshot = async () => {
    return await rpcCall("evm_snapshot", []);
};
const revertToSnapshot = async (snapId) => {
    return await rpcCall("evm_revert", [snapId]);
};
const doRequest = (url) => {
    return new Promise(function (resolve, reject) {
        request(url, function (error, res, body) {
            if (!error && res.statusCode == 200) {
                resolve(JSON.parse(body));
            } else {
                reject(error);
            }
        });
    });
};
const replaceAll = (str, find, replace) => {
    return str.replace(new RegExp(find, 'g'), replace);
};
const displayNicely = function (Obj) {
    colors.setTheme({
        key: 'bgGreen',
        value: 'cyan',
    });
    Object.keys(Obj).forEach(function (key) {
        const value = Obj[key];
        let showValue = value;
        if (value == null) {
            console.log(`${key.bgGreen} : ${showValue}`);
        }
        else if (BigNumber.isBigNumber(value)) {
            showValue = value.toString();
        }
        else if (typeof value === 'object') {
            console.log("\n");
            console.log(key);
            if (value instanceof Map) {
                for (let i = 0; i < value.size; i++) {
                    console.log(i);
                    displayNicely(value.get(i));
                }
            } else {
                displayNicely(value);
            }
            showValue = null;
        }
        if (showValue !== null) {
            console.log(`${key.bgGreen} : ${showValue}`);
        }
    });
};

module.exports = { displayNicely, loadMCDEXInfo, loadLemmaInfo, deployLemmaLocally, toBigNumber, fromBigNumber, snapshot, revertToSnapshot, doRequest, replaceAll, tokenTransfers, sqrt };

