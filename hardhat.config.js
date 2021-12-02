require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-ethers");
require("solidity-coverage");

require("dotenv").config();

// This is a sample Hardhat task. To learn how to create your own go to
// https://hardhat.org/guides/create-task.html
task("accounts", "Prints the list of accounts", async () => {
  const accounts = await ethers.getSigners();

  for (const account of accounts) {
    console.log(account.address);
  }
});

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: "0.7.6",
  networks: {
    hardhat: {
      forking: {
        url: `https://arbitrum-rinkeby.infura.io/v3/${process.env.INFURA_API_KEY}`,
        blockNumber: 13526812
      },
      accounts: {
        mnemonic: process.env.MNEMONIC
      },
      allowUnlimitedContractSize: true,
    },
    local: {
      url: "http://localhost:8545",
      timeout: 100000000 //1000 secs
    },
    arbitrumRinkeby: {
      accounts: {
        mnemonic: process.env.MNEMONIC
      },
      url: `https://arbitrum-rinkeby.infura.io/v3/${process.env.INFURA_API_KEY}`,
      timeout: 100000000 //1000 secs
    },
  },
  solidity: {
    version: "0.7.6",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  mocha: {
    timeout: 10000000 //1000 secs
  },
};