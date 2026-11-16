'use strict';

class Account {
  constructor() { this._balance = 0; this._audit = []; }

  set balance(value) {
    if (value < 0) throw new RangeError('negative balance');
    this._balance = value;
  }

  deposit(amount) {
    this.balance = this._balance + amount;
  }
}

module.exports = { Account };
