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

