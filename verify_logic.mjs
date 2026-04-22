
import { PrivateKey, utils } from 'symbol-sdk';
import * as symbol_pkg from 'symbol-sdk/symbol';
const { SymbolFacade, KeyPair } = symbol_pkg;

async function testBuildLogic() {
    console.log("--- Testing Transaction Build Logic ---");
    
    const facade = new SymbolFacade('testnet');
    const OPERATOR_KEY = 'CED3DD0A92ECC31FA33C32BF46356255145D9FA93FEE1FB9E11A10CDF39F44BC';
    const operatorKeyPair = new KeyPair(new PrivateKey(OPERATOR_KEY));
    
    const buyerPublicKey = '62B79C973DBD5D7B8491F36F4CEEBF926C758BD456D853C3850133C388400206';
    const sellerPublicKey = 'BC6F23A5C8926FDC6B39A5CB6157656A323BF0EDA6A14ABF9BC1A1500A14CA3E';
    
    const buyerPubKeyObj = new symbol_pkg.PublicKey(buyerPublicKey);
    const sellerPubKeyObj = new symbol_pkg.PublicKey(sellerPublicKey);
    
    const epochAdjustment = 1667250467;
    const deadline = BigInt(Date.now() - epochAdjustment * 1000 + 7200000);
    const CURRENCY_ID = '72C0212E67A08BCE';

    try {
        const txs = [];
        // 1. Transfer (Buyer -> Seller)
        txs.push(facade.transactionFactory.createEmbedded({
            type: 'transfer_transaction_v1',
            signerPublicKey: buyerPubKeyObj,
            recipientAddress: facade.network.publicKeyToAddress(sellerPubKeyObj),
            mosaics: [{ mosaicId: BigInt('0x' + CURRENCY_ID), amount: 1000000n }],
            message: new Uint8Array([0, ...Buffer.from('Test Message')])
        }));

        // 2. Aggregate Complete V2
        const merkleRoot = facade.constructor.hashEmbeddedTransactions(txs);
        const aggregateTx = facade.transactionFactory.create({
            type: 'aggregate_complete_transaction_v2',
            signerPublicKey: operatorKeyPair.publicKey,
            deadline: deadline,
            transactionsHash: merkleRoot,
            transactions: txs,
            fee: 1000000n
        });

        // Sign
        const sig = facade.signTransaction(operatorKeyPair, aggregateTx);
        const payload = utils.uint8ToHex(facade.transactionFactory.constructor.attachSignature(aggregateTx, sig));
        
        console.log("SUCCESS: Transaction payload generated.");
        console.log("Payload Length:", payload.length);
        console.log("Aggregate Hash:", facade.hashTransaction(aggregateTx).toString());
        
        // Verify version is V2
        if (aggregateTx.version === 2) {
            console.log("SUCCESS: Transaction version is V2.");
        } else {
            console.log("ERROR: Transaction version is NOT V2! Current version:", aggregateTx.version);
        }

    } catch (error) {
        console.error("FAILED: Build logic error:", error);
    }
}

testBuildLogic();
