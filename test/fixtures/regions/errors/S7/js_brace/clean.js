'use strict';

function parseLine(text) {
  const parts = text.split(';');
  return parts.map((p) => p.trim());
}

function render(items) {
  const out = [];
  for (const item of items) {
    if (!item) { continue; }
    out.push(`${item.name}: ${item.total}`);
  }
  return out.join('\n');
}

function total(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.total;
  }
  return sum;
}

module.exports = { parseLine, render, total };
