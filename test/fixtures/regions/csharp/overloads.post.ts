// A TypeScript overload set (04 section 3.12): two signatures and the implementation.
function f(x: number): number;
function f(x: string): string;
function f(x: boolean): boolean;
function f(x: any): any {
  return x;
}

export { f };
