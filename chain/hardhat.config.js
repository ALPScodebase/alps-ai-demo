require("@nomicfoundation/hardhat-ethers");
require("dotenv").config({path: "../.env"})
require("hardhat-gas-reporter");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.24",
  networks: {
    hardhat: {
      chainId: 31337,
      blockGasLimit: 60000000, // Setting to 60M (see https://etherscan.io/chart/gaslimit)
      accounts: {
        count: 50
      },
      mining: {
        auto: false,
        interval: 12000, // mine a block every 12 seconds (see https://etherscan.io/chart/blocktime)
      },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    docker: {
      url: process.env.CHAIN_RPC_URL || "http://chain:8545",    
    }
  },
  gasReporter: {
    enabled: true,
    currency: "USD",
    showTimeSpent: true,
    showMethodSig: true,
    trackGasDeltas: true
  },
};