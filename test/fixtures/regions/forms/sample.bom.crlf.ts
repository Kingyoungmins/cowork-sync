// 한글 주석: 가격 계산 😀
export const greeting: string = '‘hello’ and “world”';
export const separated: string = 'first second';

export function total(items: Array<{ price: number }>): number {
  // 합계
  return items.reduce((s, i) => s + i.price, 0);
}
