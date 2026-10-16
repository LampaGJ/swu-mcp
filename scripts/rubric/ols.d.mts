export interface OlsCoef {
  name: string;
  b: number;
  se: number;
  lo: number;
  hi: number;
}
export interface OlsFit {
  coefs: OlsCoef[];
  beta: number[];
  resid: number[];
  n: number;
  k: number;
  r2: number;
  rmse: number;
}
export function ols(X: number[][], y: number[], names?: string[]): OlsFit;
