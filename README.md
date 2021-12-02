# Usdl-Arbitrageur

## Steps to setup usdl-arbitrageur

1). Clone usdl-arbitrageur repo.

    1. git clone --recurse-submodules https://github.com/lemma-finance/usdl-arbitrageur
    2. cd usdl-arbitrageur
    3. yarn
    4. npx hardhat compile

2). add .env file with below config 

    MNEMONIC=''  
    INFURA_API_KEY=  
    PRIVATE_KEY=  

3). Run Script on testnet arbitrum rinkeby.   
```It will perform actual change in your wallet.```
    
    npx hardhat run scripts/arb_script.js --network arbitrumRinkeby
