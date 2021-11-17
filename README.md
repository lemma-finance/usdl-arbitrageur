# test setup
1. git clone --recurse-submodules https://github.com/lemma-finance/usdl-arbitrageur
2. cd usdl-arbitrageur
3. npm install
4. cd basis-trading-stablecoin/
5. npm install
6. cd mai-protocol-v3/
7. git checkout use-mainnet-weth
8. npm install --force
9. cd ../../
10. npx hardhat node
11. npx hardhat test --network local

# test script 
1). Install and compile
    yarn
    npx hardhat compile

2). add .env file with below config  

    MNEMONIC=''  
    INFURA_API_KEY=  
    ALCHEMY_API_KEY=  
    ETHERSCAN_API_KEY=  
    FORK_ENABLED="false"  
    PRIVATE_KEY=  

3). Run Script on arbitrum rinkeby.   
```It will perform actual change in your wallet.```
    
    npx hardhat run scripts/arb_script.js --network arbitrumRinkeby
