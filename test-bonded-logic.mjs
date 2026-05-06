import * as symbol_pkg_main from 'symbol-sdk';
import * as symbol_pkg_core from 'symbol-sdk/symbol';

const { SymbolFacade, KeyPair, models } = symbol_pkg_core;
const { PrivateKey, utils } = symbol_pkg_main;

async function testBondedLogic() {
    console.log("--- Bonded Logic Verification Start ---");
    const facade = new SymbolFacade('testnet');
    
    const operatorKey = new PrivateKey(utils.hexToUint8('CED3DD0A92ECC31FA33C32BF46356255145D9FA93FEE1FB9E11A10CDF39F44BC'));
    const buyerKey = new PrivateKey(utils.hexToUint8('ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890'));
    
    const operatorKeyPair = new KeyPair(operatorKey);
    const buyerKeyPair = new KeyPair(buyerKey);

    const deadline = BigInt(Date.now() - 1667250467 * 1000 + 7200000);

    const txPayment = facade.transactionFactory.createEmbedded({
        type: 'transfer_transaction_v1',
        signerPublicKey: buyerKeyPair.publicKey,
        recipientAddress: facade.network.publicKeyToAddress(operatorKeyPair.publicKey).toString(),
        mosaics: [],
        message: new Uint8Array([0, ...Buffer.from('Test')])
    });

    const transactions = [txPayment];
    const transactionsHash = facade.constructor.hashEmbeddedTransactions(transactions);
    console.log("Transactions Hash calculated:", transactionsHash.toString());

    try {
        const aggregateTx = facade.transactionFactory.create({
            type: 'aggregate_bonded_transaction_v2',
            signerPublicKey: operatorKeyPair.publicKey,
            deadline: deadline,
            fee: 1000000n,
            transactionsHash: transactionsHash,
            transactions: transactions
        });
        console.log("Aggregate Bonded created.");

        const sigOperator = facade.signTransaction(operatorKeyPair, aggregateTx);
        aggregateTx.signature = new models.Signature(sigOperator.bytes);
        
        const cosig = facade.cosignTransaction(buyerKeyPair, aggregateTx);
        aggregateTx.cosignatures.push(cosig);

        const bondedHash = facade.hashTransaction(aggregateTx).toString();
        console.log("Bonded Hash:", bondedHash);

        const hashLockTx = facade.transactionFactory.create({
            type: 'hash_lock_transaction_v1',
            signerPublicKey: operatorKeyPair.publicKey,
            deadline: deadline,
            fee: 100000n,
            mosaic: { mosaicId: 0x72C0212E1A951CC2n, amount: 10000000n },
            duration: 480n,
            hash: new models.Hash256(utils.hexToUint8(bondedHash))
        });
        console.log("Hash Lock Transaction created.");
        
        const sigHashLock = facade.signTransaction(operatorKeyPair, hashLockTx);
        hashLockTx.signature = new models.Signature(sigHashLock.bytes);
        
        console.log("Serialization Test:");
        console.log("Bonded Payload Length:", utils.uint8ToHex(aggregateTx.serialize()).length);
        console.log("HashLock Payload Length:", utils.uint8ToHex(hashLockTx.serialize()).length);
        console.log("--- SUCCESS ---");
    } catch (e) {
        console.error("FAILED with error:", e.message);
        if (e.stack) console.error(e.stack);
    }
}

testBondedLogic().catch(console.error);
