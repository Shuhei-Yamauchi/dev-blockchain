const superagent = require('superagent');
const Blockchain = require('../blockchain');
const Block = require('../blockchain/block');
const Blocks = require('../blockchain/blocks');
const Filter = require('../blockchain/filter');
const Transactions = require('../blockchain/transactions');
const R = require('ramda');
const Config = require('../config');

class Node {
    constructor(host, port, peers, blockchain) {
        this.host = host;
        this.port = port;
        this.peers = [];
        this.blockchain = blockchain;
        // チェーンを複数格納できるチェーンリスト
        this.blockchains = [this.blockchain.getAllBlocks()];
        this.hookBlockchain();
        this.connectToPeers(peers);
    }

    hookBlockchain() {
        // Hook blockchain so it can broadcast blocks or transactions changes
        // 7a. ブロックt+1のA部とB部をブロードキャストする。
        this.blockchain.emitter.on('blockAdded', (block) => {
            // ブロックt+1のA部をブロードキャストし，次いでブロックt+1の残りの部分をブロードキャストする。
            // this.broadcast(this.sendLatestBlock, block);
            this.broadcast(this.sendLatestBlock, { ...block, transactions: [] });
            this.broadcast(this.sendLatestBlockTransactions, block.transactions);
        });

        // ユーザノードが暗号資産の取引を行う際のブロードキャスト
        this.blockchain.emitter.on('transactionAdded', (newTransaction) => {
            this.broadcast(this.sendTransaction, newTransaction);
        });

        // 各自でチェーンリストから繋げ直すのでここはemit待ち不要
        // this.blockchain.emitter.on('blockchainReplaced', (blocks) => {
        //     this.broadcast(this.sendLatestBlock, R.last(blocks));
        // });
    }

    connectToPeer(newPeer) {
        this.connectToPeers([newPeer]);
        return newPeer;
    }

    connectToPeers(newPeers) {
        // Connect to every peer
        let me = `http://${this.host}:${this.port}`;
        newPeers.forEach((peer) => {
            // If it already has that peer, ignore.
            if (!this.peers.find((element) => { return element.url == peer.url; }) && peer.url != me) {
                this.sendPeer(peer, { url: me });
                console.info(`Peer ${peer.url} added to connections.`);
                this.peers.push(peer);
                this.initConnection(peer);
                this.broadcast(this.sendPeer, peer);
            } else {
                console.info(`Peer ${peer.url} not added to connections, because I already have.`);
            }
        }, this);

    }

    initConnection(peer) {
        // It initially gets the latest block and all pending transactions
        this.getLatestBlock(peer);
        this.getTransactions(peer);
    }

    sendPeer(peer, peerToSend) {
        const URL = `${peer.url}/node/peers`;
        console.info(`Sending ${peerToSend.url} to peer ${URL}.`);
        return superagent
            .post(URL)
            .send(peerToSend)
            .catch((err) => {
                console.warn(`Unable to send me to peer ${URL}: ${err.message}`);
            });
    }

    getLatestBlock(peer) {
        const URL = `${peer.url}/blockchain/blocks/latest`;
        let self = this;
        console.info(`Getting latest block from: ${URL}`);
        return superagent
            .get(URL)
            .then((res) => {
                // Check for what to do with the latest block
                self.checkReceivedBlock(Block.fromJson(res.body));
            })
            .catch((err) => {
                console.warn(`Unable to get latest block from ${URL}: ${err.message}`);
            });
    }

    sendLatestBlock(peer, block) {
        const URL = `${peer.url}/blockchain/blocks/latest`;
        console.info(`Posting latest block to: ${URL}`);
        return superagent
            .put(URL)
            .send(block)
            .catch((err) => {
                console.warn(`Unable to post latest block to ${URL}: ${err.message}`);
            });
    }

    sendLatestBlockTransactions(peer, transactions) {
        const URL = `${peer.url}/blockchain/blocks/transactions`;
        console.info(`Posting latest block transactions to: ${URL}`);
        return superagent
            .put(URL)
            .send(transactions)
            .catch((err) => {
                console.warn(`Unable to post latest block transactions to ${URL}: ${err.message}`);
            });
    }

    getBlocks(peer) {
        const URL = `${peer.url}/blockchain/blocks`;
        let self = this;
        console.info(`Getting blocks from: ${URL}`);
        return superagent
            .get(URL)
            .then((res) => {
                // Check for what to do with the block list
                self.checkReceivedBlocks(Blocks.fromJson(res.body));
            })
            .catch((err) => {
                console.warn(`Unable to get blocks from ${URL}: ${err.message}`);
            });
    }

    sendTransaction(peer, transaction) {
        const URL = `${peer.url}/blockchain/transactions`;
        console.info(`Sending transaction '${transaction.id}' to: '${URL}'`);
        return superagent
            .post(URL)
            .send(transaction)
            .catch((err) => {
                console.warn(`Unable to put transaction to ${URL}: ${err.message}`);
            });
    }

    getTransactions(peer) {
        const URL = `${peer.url}/blockchain/transactions`;
        let self = this;
        console.info(`Getting transactions from: ${URL}`);
        return superagent
            .get(URL)
            .then((res) => {
                self.syncTransactions(Transactions.fromJson(res.body));
            })
            .catch((err) => {
                console.warn(`Unable to get transations from ${URL}: ${err.message}`);
            });
    }

    getConfirmation(peer, transactionId) {
        // Get if the transaction has been confirmed in that peer
        const URL = `${peer.url}/blockchain/blocks/transactions/${transactionId}`;
        console.info(`Getting transactions from: ${URL}`);
        return superagent
            .get(URL)
            .then(() => {
                return true;
            })
            .catch(() => {
                return false;
            });
    }

    getConfirmations(transactionId) {
        // Get from all peers if the transaction has been confirmed
        let foundLocally = this.blockchain.getTransactionFromBlocks(transactionId) != null ? true : false;
        return Promise.all(R.map((peer) => {
            return this.getConfirmation(peer, transactionId);
        }, this.peers))
            .then((values) => {
                return R.sum([foundLocally, ...values]);
            });
    }

    broadcast(fn, ...args) {
        // Call the function for every peer connected
        console.info('Broadcasting');
        this.peers.map((peer) => {
            fn.apply(this, [peer, ...args]);
        }, this);
    }

    syncTransactions(transactions) {
        // For each received transaction check if we have it, if not, add.
        R.forEach((transaction) => {
            let transactionFound = this.blockchain.getTransactionById(transaction.id);

            if (transactionFound == null) {
                console.info(`Syncing transaction '${transaction.id}'`);
                this.blockchain.addTransaction(transaction);
            }
        }, transactions);
    }

    checkReceivedBlock(block) {
        return this.checkReceivedBlocks([block]);
    }

    checkReceivedBlocks(blocks) {
        const receivedBlocks = blocks.sort((b1, b2) => (b1.index - b2.index));
        const latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];

        // 7b.  7.の過程で，ブロックのA部を受信した場合：チェーンリストに受信したブロックで終わるチェーンを追加する。
        // 受信したブロックの一つ前およびそれ以前のブロックのA部またはB部を保持していなければ，ダウンロードしてリストに追加する。
        let isAddBlock = false;
        this.blockchains.forEach((blocks) => {
            const latestBlockHeld = R.last(blocks);;

            // // If the received blockchain is not longer than blockchain. Do nothing.
            // if (latestBlockReceived.index <= latestBlockHeld.index) {
            //     console.info('Received blockchain is not longer than blockchain. Do nothing');
            //     return false;
            // }

            console.info(`Blockchain possibly behind. We got: ${latestBlockHeld.index}, Peer got: ${latestBlockReceived.index}`);
            if (latestBlockHeld.hash === latestBlockReceived.previousHash) { // We can append the received block to our chain
                console.info('Appending received block to our chain');
                blocks.push(latestBlockReceived);
                isAddBlock = true;
                // return true;
            }
        });
        if (isAddBlock) {
            return true;
        } else if (receivedBlocks.length === 1) { // We have to query the chain from our peer
            console.info('Querying chain from our peers');
            this.broadcast(this.getBlocks);
            return null;
        } else { // Received blockchain is longer than current blockchain
            console.info('Received blockchain is longer than current blockchain');
            // this.blockchain.replaceChain(receivedBlocks);
            this.blockchains.push(receivedBlocks);
            // ステップ2 へ
            this.selectBlockchain();
            return true;
        }
    }

    checkReceivedTransactions(transactions) {
        // 7c. 7.の過程で，あるブロックのB部の受信を完了した場合：受信したブロックをブロックuと呼ぶ。

        // ブロックuのB部に格納されているアイテム全ての検証を行い，
        // 成功した場合，ブロックKに受信したブロックuのB部を追加する。
        let isValid = R.all(R.equals(true), R.map((transaction) => {
            return this.blockchain.checkTransaction(transaction);
        }, transactions));
        if (!isValid) {
            return null;
        }

        // ブロックuのB部のハッシュ値
        const transactionsHash = transactions.toHash();
        // 受信したブロックuのB部から求められる，「ブロックuをブロックチェーンに新たに追加することでブロックuを追加する前の状態から状態の変化する可能性のあるアカウントの集合を表すデータ(ブルームフィルタ)」
        const filter = Filter.from(transactions.getAccounts(), Config.FILTER_ERROR_RATE);

        this.blockchains.forEach((blocks) => {
            // 後ろから走査
            for (let i = blocks.length - 1; i >= 0; i--) {
                const block = blocks[i];
                // チェーンリスト内のB部の欠落した各ブロックKについて，
                if (block.transactions == null || block.transactions.length === 0) {
                    // ブロックKのA部に含まれている「ブロックKのB部のハッシュ値」と，受信したブロックuのB部のハッシュ値が一致し，
                    // かつ受信したブロックuのB部から求められる，
                    // 「ブロックuをブロックチェーンに新たに追加することでブロックuを追加する前の状態から状態の変化する可能性のあるアカウントの集合を表すデータ(ブルームフィルタ)」
                    // と，ブロックKのA部に含まれているブルームフィルタが一致する場合に，
                    // ブロックKに受信したブロックuのB部を追加する
                    if (block.transactionsHash === transactionsHash && filter.equals(block.filter)) {
                        block.transactions = transactions;
                        break;
                    }
                }
            };
        });
        return transactions;
    }

    selectBlockchain() {
        // 2.  チェーンリスト内の最長のチェーンより一定ブロック数以上短いチェーンをチェーンリストから全て削除する。
        const maxLength = this.blockchains.reduce((len, blocks) => Math.max(len, blocks.length), 0);
        for (let i = this.blockchains.length - 1; i >= 0; i--) {
            if (this.blockchains[i].length <= maxLength - Config.BLOCKCHAINS_LENGTH_DIFF_MAX) {
                this.blockchains.splice(i, 1);
            }
        }

        // 3.  チェーンリスト中のチェーンそれぞれについてブロックの数を評価し，これをチェーンの適合度とする。
        // チェーンリストから，最後のブロックの一つ前およびそれ以前の全ブロックについてA 部とB部の両方を保持しており，
        // 最後のブロックのA 部を保持しているチェーンの中で，
        // 最も適合度の高いチェーンを選択する。但し，このチェーンはリストから削除しない。
        const hasAllBlocks = (blocks) => {
            const blockLength = blocks.length;
            for (let i = 0; i < blockLength; i++) {
                const block = blocks[i];
                // A部を保持しているか
                if (i > 0 && block.filter == null) {
                    return false;
                }
                // B部を保持しているか(最後のブロック以外)
                if (i === blockLength - 1) break;
                if (block.transactions == null || block.transactions.length === 0) {
                    return false;
                }
            };
            return true;
        }
        let fitnessMax = 0;
        let longestBlocks = null;
        R.forEach((blocks) => {
            const blockLength = blocks.length;
            if (fitnessMax < blockLength && hasAllBlocks(blocks)) {
                fitnessMax = blockLength;
                longestBlocks = blocks;
            }
        }, this.blockchains);

        // 以降このチェーンをマイニングの対象とする。
        if (longestBlocks != null) {
            // 現在のマイニング対象のチェーンと異なる場合は付け替え
            const currentBlocks = this.blockchain.getAllBlocks();
            if (currentBlocks.length !== longestBlocks.length
                && R.last(currentBlocks).hash !== R.last(longestBlocks).hash) {
                this.blockchain.replaceChain(longestBlocks);
            }
        }
    }
}

module.exports = Node;
