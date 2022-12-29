const R = require('ramda');
const spawn = require('threads').spawn;
const Block = require('../blockchain/block');
const Filter = require('../blockchain/filter');
const CryptoUtil = require('../util/cryptoUtil');
const Transaction = require('../blockchain/transaction');
const Transactions = require('../blockchain/transactions');
const Config = require('../config');

class Miner {
    constructor(blockchain, logLevel) {
        this.blockchain = blockchain;
        this.logLevel = logLevel;
    }

    mine(rewardAddress, feeAddress) {
        let baseBlock = Miner.generateNextBlock(rewardAddress, feeAddress, this.blockchain);
        process.execArgv = R.reject((item) => item.includes('debug'), process.execArgv);

        /* istanbul ignore next */
        const thread = spawn(function (input, done) {
            /*eslint-disable */
            require(input.__dirname + '/../util/consoleWrapper.js')('mine-worker', input.logLevel);
            const Block = require(input.__dirname + '/../blockchain/block');
            const Miner = require(input.__dirname);
            /*eslint-enable */

            done(Miner.proveWorkFor(Block.fromJson(input.jsonBlock), input.difficulty));
        });

        const transactionList = R.pipe(
            R.countBy(R.prop('type')),
            R.toString,
            R.replace('{', ''),
            R.replace('}', ''),
            R.replace(/"/g, '')
        )(baseBlock.transactions);

        console.info(`Mining a new block with ${baseBlock.transactions.length} (${transactionList}) transactions`);

        const promise = thread.promise().then((result) => {
            thread.kill();
            return result;
        });

        thread.send({
            __dirname: __dirname,
            logLevel: this.logLevel,
            jsonBlock: baseBlock,
            difficulty: this.blockchain.getDifficulty()
        });

        return promise;
    }

    static generateNextBlock(rewardAddress, feeAddress, blockchain) {
        // ブロックt(マイニングの対象とするチェーンの最後のブロック)
        const previousBlock = blockchain.getLastBlock();
        const index = previousBlock.index + 1;
        // ブロックtのA部のハッシュ値
        const previousHash = previousBlock.hash;
        const timestamp = new Date().getTime() / 1000;
        const blocks = blockchain.getAllBlocks();
        const candidateTransactions = blockchain.transactions;
        const transactionsInBlocks = R.flatten(R.map(R.prop('transactions'), blocks));
        // TODO: UTXO to Account By Yama
        const inputTransactionsInTransaction = R.compose(R.flatten, R.map(R.compose(R.prop('inputs'), R.prop('data'))));

        // Select transactions that can be mined         
        let rejectedTransactions = new Transactions();
        let selectedTransactions = new Transactions();

        // 4.  ブロックt(マイニングの対象とするチェーンの最後のブロック)のB部を保持している場合は，
        // アイテムリストに含まれるアイテムのうち，ブロックtおよびそれ以前のブロックに含まれておらず，
        // 検証に成功したアイテム全てをブロックt+1に格納するアイテムとして選定する。
        const hasTransaction = previousBlock.transactions != null && previousBlock.transactions.length > 0;

        // TODO: UTXO to Account By Yama
        R.forEach((transaction) => {
            let negativeOutputsFound = 0;
            let i = 0;
            let outputsLen = transaction.data.outputs.length;

            // Check for negative outputs (avoiding negative transactions or 'stealing')
            for (i = 0; i < outputsLen; i++) {
                if (transaction.data.outputs[i].amount < 0) {
                    negativeOutputsFound++;
                }
            }
            // Check if any of the inputs is found in the selectedTransactions or in the blockchain
            let transactionInputFoundAnywhere = R.map((input) => {
                let findInputTransactionInTransactionList = R.find(
                    R.whereEq({
                        'transaction': input.transaction,
                        'index': input.index
                    }));

                // Find the candidate transaction in the selected transaction list (avoiding double spending)
                let wasItFoundInSelectedTransactions = R.not(R.isNil(findInputTransactionInTransactionList(inputTransactionsInTransaction(selectedTransactions))));

                // Find the candidate transaction in the blockchain (avoiding mining invalid transactions)
                let wasItFoundInBlocks = R.not(R.isNil(findInputTransactionInTransactionList(inputTransactionsInTransaction(transactionsInBlocks))));

                return wasItFoundInSelectedTransactions || wasItFoundInBlocks;
            }, transaction.data.inputs);

            // 5.  ブロックtのB部を保持していない場合は，アイテムリストに含まれるアイテムのうち，
            // ブロックt-1およびそれ以前のブロックに含まれておらず，検証に成功したアイテムのうち，
            let existsAccountInTransaction = false;
            if (!hasTransaction) {
                // ブロックtのA部に含まれる
                // 「ブロックtをブロックチェーンに新たに追加することでブロックtを追加する前の状態から状態の変化する可能性のあるアカウントの集合を表すデータ」
                // の表すアカウントのいずれも参照しないアイテム全てをブロックt+1に格納するアイテムとして選定する。
                const previousFilter = previousBlock.filter;
                existsAccountInTransaction = R.any(R.equals(true), R.map((account) => {
                    return previousFilter.has(account);
                }, transaction.getAccounts()));
            }

            if (R.all(R.equals(false), R.flatten(transactionInputFoundAnywhere, existsAccountInTransaction))) {
                if (transaction.type === 'regular' && negativeOutputsFound === 0) {
                    selectedTransactions.push(transaction);
                } else if (transaction.type === 'reward') {
                    selectedTransactions.push(transaction);
                } else if (negativeOutputsFound > 0) {
                    rejectedTransactions.push(transaction);
                }
            } else {
                rejectedTransactions.push(transaction);
            }
        }, candidateTransactions);

        console.info(`Selected ${selectedTransactions.length} candidate transactions with ${rejectedTransactions.length} being rejected.`);

        // Get the first two avaliable transactions, if there aren't TRANSACTIONS_PER_BLOCK, it's empty
        // 6.  ステップ4と5で選定したアイテムから，一つのブロックに格納できる数のアイテムを選定してブロックt+1のB部を構成し，
        let transactions = R.defaultTo(new Transactions(), R.take(Config.TRANSACTIONS_PER_BLOCK, selectedTransactions));

        // Add fee transaction (1 satoshi per transaction)        
        if (transactions.length > 0) {
            // TODO: UTXO to Account By Yama
            let feeTransaction = Transaction.fromJson({
                id: CryptoUtil.randomId(64),
                hash: null,
                type: 'fee',
                data: {
                    inputs: [],
                    outputs: [
                        {
                            amount: Config.FEE_PER_TRANSACTION * transactions.length, // satoshis format
                            address: feeAddress, // INFO: Usually here is a locking script (to check who and when this transaction output can be used), in this case it's a simple destination address 
                        }
                    ]
                }
            });

            transactions.push(feeTransaction);
        }

        // Add reward transaction of 50 coins
        if (rewardAddress != null) {
            // TODO: UTXO to Account By Yama
            let rewardTransaction = Transaction.fromJson({
                id: CryptoUtil.randomId(64),
                hash: null,
                type: 'reward',
                data: {
                    inputs: [],
                    outputs: [
                        {
                            amount: Config.MINING_REWARD, // satoshis format
                            address: rewardAddress, // INFO: Usually here is a locking script (to check who and when this transaction output can be used), in this case it's a simple destination address 
                        }
                    ]
                }
            });

            transactions.push(rewardTransaction);
        }

        // ブロックt+1のB部に含まれる全てのアイテムそれぞれが上書きするアカウントの集合の和集合を求めることで，
        // 「ブロックt+1をマイニングの対象とするブロックチェーンに新たに追加することでブロックt+1 を追加する前の状態から状態の変化する可能性のあるアカウントの集合」
        // を求める。
        // 求めた集合を表すデータ(ブルームフィルタ)を生成し，
        const filter = Filter.from(transactions.getAccounts(), Config.FILTER_ERROR_RATE);

        // ブロックt+1のB部のハッシュ値を計算する。
        const transactionsHash = transactions.toHash();

        // このブルームフィルタとブロックt+1のB部のハッシュ値，ブロックtのA部のハッシュ値からブロックt+1のA部を構成する。
        return Block.fromJson({
            index,
            nonce: 0,
            previousHash,
            timestamp,
            transactions,
            transactionsHash,
            filter,
        });
    }

    /* istanbul ignore next */
    static proveWorkFor(jsonBlock, difficulty) {
        let blockDifficulty = null;
        let start = process.hrtime();
        let block = Block.fromJson(jsonBlock);

        // INFO: Every cryptocurrency has a different way to prove work, this is a simple hash sequence

        // Loop incrementing the nonce to find the hash at desired difficulty
        do {
            block.timestamp = new Date().getTime() / 1000;
            block.nonce++;
            block.hash = block.toHash();
            blockDifficulty = block.getDifficulty();
        } while (blockDifficulty >= difficulty);
        console.info(`Block found: time '${process.hrtime(start)[0]} sec' dif '${difficulty}' hash '${block.hash}' nonce '${block.nonce}'`);
        return block;
    }
}

module.exports = Miner;
