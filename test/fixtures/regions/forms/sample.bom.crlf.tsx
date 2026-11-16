// 한글 주석: 가격 계산 😀
const greeting = '‘hello’ and “world”';
const separated = 'first second';

export function Total(props: { items: Array<{ price: number }> }) {
  const sum = props.items.reduce((s, i) => s + i.price, 0);
  return <span title={separated}>{greeting}: {sum} 합계</span>;
}
