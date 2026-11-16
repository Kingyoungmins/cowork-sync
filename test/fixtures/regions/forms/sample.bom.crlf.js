// 한글 주석: 가격 계산 😀
const greeting = '‘hello’ and “world”';
const separated = 'first second';

function total(items) {
  // 합계
  return items.reduce((s, i) => s + i.price, 0);
}

module.exports = { greeting, separated, total };
