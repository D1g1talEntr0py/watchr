import type { BigIntStats } from 'node:fs';

type Expand<T> = { [K in keyof T]: T[K] } & {};

export type InodeNumber = bigint | number;
export type Stats = Expand<BigIntStats>;
