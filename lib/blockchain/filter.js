const { BloomFilter } = require('bloom-filters');

class Filter extends BloomFilter { }
BloomFilter.prototype.toJSON = function () {
    return this.saveAsJSON();
}

module.exports = Filter;
