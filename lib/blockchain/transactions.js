const Transaction = require('./transaction');
const CryptoUtil = require('../util/cryptoUtil');
const R = require('ramda');

class Transactions extends Array {
    // B部のハッシュ値算出
    toHash() {
        // INFO: There are different implementations of the hash algorithm, for example: https://en.bitcoin.it/wiki/Hashcash
        return CryptoUtil.hash(JSON.stringify(this));
    }

    // アイテムにより上書きされるアカウントの一覧取得
    getAccounts() {
        let accounts = new Set();
        R.forEach((transaction) => {
            R.forEach((account) => {
                accounts.add(account);
            }, transaction.getAccounts());
        }, this);
        return accounts;
    }

    static fromJson(data) {
        let transactions = new Transactions();
        R.forEach((transaction) => { transactions.push(Transaction.fromJson(transaction)); }, data);
        return transactions;
    }
}

module.exports = Transactions;