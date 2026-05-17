import type { FilterRule } from '../schemas/dsl.js';
import { evalJsonata } from './jsonata.js';
import { resolvePath } from './path.js';

export type FilterResult = { passed: true } | { passed: false; reason: string };

export async function evaluateFilters(rules: FilterRule[], listing: unknown): Promise<FilterResult> {
  for (const rule of rules) {
    const ok = await evaluateOne(rule, listing);
    if (!ok.passed) return ok;
  }
  return { passed: true };
}

async function evaluateOne(rule: FilterRule, listing: unknown): Promise<FilterResult> {
  if (rule.kind === 'expr') {
    let result: unknown;
    try {
      result = await evalJsonata(rule.expr, listing);
    } catch (err) {
      return onMissing(rule.on_missing, `expr threw: ${(err as Error).message}`);
    }
    if (result === undefined) return onMissing(rule.on_missing, `expr resolved to undefined: ${rule.expr}`);
    return result ? { passed: true } : { passed: false, reason: `expr false: ${rule.expr}` };
  }
  const value = resolvePath(listing, rule.field);
  if (value === undefined) return onMissing(rule.on_missing, `missing field: ${rule.field}`);
  return compareOp(rule.op, value, rule.value)
    ? { passed: true }
    : { passed: false, reason: `${rule.field} ${rule.op} ${JSON.stringify(rule.value)} → got ${JSON.stringify(value)}` };
}

function onMissing(mode: 'fail' | 'pass' | 'skip', reason: string): FilterResult {
  if (mode === 'fail') return { passed: false, reason };
  return { passed: true };
}

function compareOp(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '>':
      return typeof left === 'number' && typeof right === 'number' && left > right;
    case '>=':
      return typeof left === 'number' && typeof right === 'number' && left >= right;
    case '<':
      return typeof left === 'number' && typeof right === 'number' && left < right;
    case '<=':
      return typeof left === 'number' && typeof right === 'number' && left <= right;
    case 'in':
      return Array.isArray(right) && right.includes(left as never);
    case 'not_in':
      return Array.isArray(right) && !right.includes(left as never);
    case 'contains':
      if (typeof left === 'string' && typeof right === 'string') return left.includes(right);
      if (Array.isArray(left)) return (left as unknown[]).includes(right);
      return false;
    case 'regex':
      return typeof left === 'string' && typeof right === 'string' && new RegExp(right).test(left);
    default:
      return false;
  }
}
