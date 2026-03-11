import type { SkillMetadata, SkillContext, SkillResult } from '@alfred/types';
import { Skill } from '../skill.js';

/* ------------------------------------------------------------------ */
/*  Safe recursive-descent math parser (no eval / no new Function)    */
/*  Grammar:                                                          */
/*    expr    = term (('+' | '-') term)*                              */
/*    term    = unary (('*' | '/' | '%') unary)*                     */
/*    unary   = '-' unary | primary                                   */
/*    primary = NUMBER | 'Math.' CONST | 'Math.' FN '(' args ')' | '(' expr ')' */
/*    args    = expr (',' expr)*                                      */
/* ------------------------------------------------------------------ */

const MATH_FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  sqrt: Math.sqrt, pow: Math.pow, abs: Math.abs,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  log: Math.log, log2: Math.log2, log10: Math.log10,
};

const MATH_CONSTS: Record<string, number> = {
  PI: Math.PI, E: Math.E,
};

type Token =
  | { type: 'num'; value: number }
  | { type: 'op'; value: string }
  | { type: 'fn'; value: string }
  | { type: 'const'; value: number }
  | { type: 'paren'; value: '(' | ')' }
  | { type: 'comma' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === ' ' || src[i] === '\t') { i++; continue; }

    // Numbers (including decimals like .5 or 3.14)
    if (/[\d.]/.test(src[i])) {
      let num = '';
      while (i < src.length && /[\d.]/.test(src[i])) num += src[i++];
      const v = Number(num);
      if (isNaN(v)) throw new Error(`Invalid number: ${num}`);
      tokens.push({ type: 'num', value: v });
      continue;
    }

    // Math.xxx
    if (src.startsWith('Math.', i)) {
      i += 5; // skip "Math."
      let name = '';
      while (i < src.length && /[a-zA-Z0-9]/.test(src[i])) name += src[i++];
      if (name in MATH_CONSTS) {
        tokens.push({ type: 'const', value: MATH_CONSTS[name] });
      } else if (name in MATH_FUNCS) {
        tokens.push({ type: 'fn', value: name });
      } else {
        throw new Error(`Unknown Math member: Math.${name}`);
      }
      continue;
    }

    if ('+-*/%'.includes(src[i])) { tokens.push({ type: 'op', value: src[i++] }); continue; }
    if (src[i] === '(' || src[i] === ')') { tokens.push({ type: 'paren', value: src[i++] as '(' | ')' }); continue; }
    if (src[i] === ',') { tokens.push({ type: 'comma' }); i++; continue; }

    throw new Error(`Unexpected character: ${src[i]}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parse(): number {
    const result = this.expr();
    if (this.pos < this.tokens.length) throw new Error('Unexpected token after expression');
    return result;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private advance(): Token { return this.tokens[this.pos++]; }

  private peekOp(chars: string): string | null {
    const t = this.peek();
    if (t && t.type === 'op' && chars.includes(t.value)) return t.value;
    return null;
  }

  private expr(): number {
    let left = this.term();
    let op: string | null;
    while ((op = this.peekOp('+-')) !== null) {
      this.advance();
      const right = this.term();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private term(): number {
    let left = this.unary();
    let op: string | null;
    while ((op = this.peekOp('*/%')) !== null) {
      this.advance();
      const right = this.unary();
      if (op === '*') left = left * right;
      else if (op === '/') left = left / right;
      else left = left % right;
    }
    return left;
  }

  private unary(): number {
    if (this.peekOp('-')) {
      this.advance();
      return -this.unary();
    }
    return this.primary();
  }

  private primary(): number {
    const tok = this.peek();
    if (!tok) throw new Error('Unexpected end of expression');

    if (tok.type === 'num') { this.advance(); return tok.value; }
    if (tok.type === 'const') { this.advance(); return tok.value; }

    if (tok.type === 'fn') {
      this.advance();
      const open = this.advance();
      if (open?.type !== 'paren' || open.value !== '(') throw new Error(`Expected '(' after Math.${tok.value}`);
      const args = this.args();
      const close = this.advance();
      if (close?.type !== 'paren' || close.value !== ')') throw new Error(`Expected ')' after arguments`);
      return MATH_FUNCS[tok.value](...args);
    }

    if (tok.type === 'paren' && tok.value === '(') {
      this.advance();
      const val = this.expr();
      const close = this.advance();
      if (close?.type !== 'paren' || close.value !== ')') throw new Error('Missing closing parenthesis');
      return val;
    }

    throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
  }

  private args(): number[] {
    const list = [this.expr()];
    while (this.peek()?.type === 'comma') {
      this.advance();
      list.push(this.expr());
    }
    return list;
  }
}

function safeEval(expression: string): number {
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new Error('Empty expression');
  return new Parser(tokens).parse();
}

export class CalculatorSkill extends Skill {
  readonly metadata: SkillMetadata = {
    name: 'calculator',
    category: 'information',
    description: 'Evaluate mathematical expressions. Use for any calculation, unit conversion, or math question the user asks.',
    riskLevel: 'read',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'The mathematical expression to evaluate',
        },
      },
      required: ['expression'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    _context: SkillContext,
  ): Promise<SkillResult> {
    const expression = input.expression as string;

    if (!expression || typeof expression !== 'string') {
      return {
        success: false,
        error: 'Invalid expression: input must be a non-empty string',
      };
    }

    const trimmed = expression.trim();

    try {
      const result = safeEval(trimmed);

      if (typeof result !== 'number' || !isFinite(result)) {
        return {
          success: false,
          error: `Invalid expression: "${trimmed}" did not produce a finite number`,
        };
      }

      return {
        success: true,
        data: result,
        display: `${trimmed} = ${result}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Invalid expression: "${trimmed}" — ${msg}`,
      };
    }
  }
}
