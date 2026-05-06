import * as symbol_pkg_main from 'symbol-sdk';
import * as symbol_pkg_core from 'symbol-sdk/symbol';

const { SymbolFacade, KeyPair, models } = symbol_pkg_core;
const { PrivateKey, utils } = symbol_pkg_main;

async function verifyLogic() {
    console.log("--- Signature Logic Verification Start ---");
    const facade = new SymbolFacade('testnet');
    
    // ダミーキー
    const operatorKey = new PrivateKey(utils.hexToUint8('CED3DD0A92ECC31FA33C32BF46356255145D9FA93FEE1FB9E11A10CDF39F44BC'));
    const buyerKey = new PrivateKey(utils.hexToUint8('ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890'));
    
    const operatorKeyPair = new KeyPair(operatorKey);
    const buyerKeyPair = new KeyPair(buyerKey);

    const deadline = BigInt(Date.now() - 1667250467 * 1000 + 7200000);

    // ダミーの埋め込みトランザクション
    const tx1 = facade.transactionFactory.createEmbedded({
        type: 'transfer_transaction_v1',
        signerPublicKey: buyerKeyPair.publicKey,
        recipientAddress: facade.network.publicKeyToAddress(operatorKeyPair.publicKey),
        mosaics: [],
        message: new Uint8Array([0, ...Buffer.from('Test')])
    });

    const merkleRoot = facade.constructor.hashEmbeddedTransactions([tx1]);
    const aggregateTx = facade.transactionFactory.create({
        type: 'aggregate_complete_transaction_v2',
        signerPublicKey: operatorKeyPair.publicKey,
        deadline: deadline,
        fee: 1000000n,
        transactionsHash: merkleRoot,
        transactions: [tx1]
    });

    console.log("1. Signing as Operator...");
    const sigOperator = facade.signTransaction(operatorKeyPair, aggregateTx);
    aggregateTx.signature = new models.Signature(sigOperator.bytes);

    console.log("2. Testing Cosigning methods...");
    try {
        const cosig = facade.cosignTransaction(buyerKeyPair, aggregateTx);
        console.log("facade.cosignTransaction success! Type:", cosig.constructor.name);
        aggregateTx.cosignatures.push(cosig);
    } catch (e) {
        console.log("facade.cosignTransaction failed:", e.message);
    }

    const payload = utils.uint8ToHex(aggregateTx.serialize());
    const hash = facade.hashTransaction(aggregateTx).toString();

    console.log("Payload Length:", payload.length);
    console.log("Transaction Hash:", hash);
    
    // 検証: SDKのデシリアライズ機能を使って、壊れていないか確認
    try {
        const deserialized = models.AggregateCompleteTransactionV2.deserialize(utils.hexToUint8(payload));
        console.log("Deserialization Success!");
        console.log("Signer PK Match:", utils.uint8ToHex(deserialized.signerPublicKey.bytes) === utils.uint8ToHex(operatorKeyPair.publicKey.bytes));
        console.log("Cosigners Count:", deserialized.cosignatures.length);
        console.log("--- Verification Success ---");
    } catch (e) {
        console.error("Deserialization Failed!", e);
    }
}

verifyLogic().catch(console.error);
