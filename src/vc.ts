/* global fetch require console */
/// <reference path="../typings/isomorphic-fetch/isomorphic-fetch.d.ts"/>
declare const require: (s: string) => any;
declare const console: { log: any };

import { varsToSMT, expressionToSMT, propositionToSMT, propositionToAssert } from "./assertions";
import { preamble } from "./defs-smt";
import { JSyntax, stringifyStmt } from "./javascript";
import { ASyntax, smtToValue } from "./assertions";
import { transformPrecondition, transformPostcondition } from "./transform";

export type SMTInput = string;
export type SMTOutput = string;

export type VarName = string;
export type Vars = { [varName: string]: number; };  // latest assigned value

type Model = { [varName: string]: any };

export type Result = { status: "unverified" }
                   | { status: "inprogress" }
                   | { status: "verified" }
                   | { status: "incorrect", model: Model, error: Error }
                   | { status: "error", error: Error }
                   | { status: "tested", model: Model };

export default class VerificationCondition {
  vars: Vars;
  prop: ASyntax.Proposition;
  post: ASyntax.Proposition;
  freeVars: Vars;
  body: Array<JSyntax.Statement>;
  description: string;
  fns: Array<JSyntax.FunctionDeclaration>;
  _smtin: SMTInput | null;
  _smtout: SMTOutput | null;
  _result: Result;

  constructor(vars: Vars, prop: ASyntax.Proposition, post: ASyntax.Proposition, description: string, freeVars: Vars = {}, body: Array<JSyntax.Statement> = []) {
 this.vars = vars;
    this.prop = prop;
    this.post = post;
    this.freeVars = freeVars;
    this.body = body;
    this.description = description;
    this.fns = [];
    this._smtin = null;
    this._smtout = null;
    this._result = { status: "unverified" };
  }

  smtInput(): SMTInput {
    const declarations = varsToSMT(this.vars),
          post = `(assert (not ${propositionToSMT(this.post)}))`;
    return this._smtin =
`${preamble(this.fns.map(f => ({ fn: f.id.name, nfreevars: f.freeVars.length })))}

; function preconditions
(define-fun pre ((f_0 JSVal) (arg_0 JSVal)) Bool${this.fns.map(f => `\n  (ite (is-jsfun-${f.id.name} f_0) ${propositionToSMT(transformPrecondition(f))}`)}
  false${this.fns.map(f => ')')})

; function postconditions
(define-fun post ((f_0 JSVal) (arg_0 JSVal)) Bool${this.fns.map(f => `\n  (ite (is-jsfun-${f.id.name} f_0) ${propositionToSMT(transformPostcondition(f))}`)}
  false${this.fns.map(f => ')')})

; declarations
${declarations}

; requirements
${propositionToAssert(this.prop)}

; post condition
${post}

(check-sat)
(get-value (${Object.keys(this.freeVars).map(v => `${v}_${this.freeVars[v]}`).join(' ')}))`;
  }

  getModel(): Model {
    let res = this._smtout;
    if (!res || !res.startsWith("sat")) throw new Error("no model available");
    if (Object.keys(this.freeVars).length == 0) return {};
    // remove "sat"
    res = res.slice(3, res.length);
    // remove outer parens
    res = res.trim().slice(2, res.length - 4);
    const model: Model = {};
    res.split(/\)\s+\(/m).forEach(str => {
      // these are now just pairs of varname value
      const both = str.trim().split(" ");
      if (both.length < 2) return;
      const name = both[0].trim(),
            value = both.slice(1, both.length).join(" ").trim();
      model[name.substr(0, name.length - 2)] = smtToValue(value);
    });
    return model;
  }

  testCode(): string {
    const model = this.getModel(),
          declarations = Object.keys(model).map(v =>
            `let ${v} = ${JSON.stringify(model[v])};\n`),
          oldValues = Object.keys(model).map(v =>
            `let ${v}_0 = ${v};\n`);
    return `
function assert(p) { if (!p) throw new Error("assertion failed"); }
${declarations.join("")}
${oldValues.join("")}

${this.body.map(s => stringifyStmt(s)).join("\n")}`;
  }

  runTest(m: Model = this.getModel()) {
    eval(this.testCode());
  }

  result(): Result {
    return this._result;
  }

  async solve(): Promise<Result> {
    this._result = { status: "inprogress" };
    try {
      this._smtout = await (typeof fetch === "undefined" ? this.solveLocal() : this.solveRequest());
    } catch (e) {
      this._result = { status: "error", error: e };
      return this._result;
    }
    if (this._smtout && this._smtout.startsWith("sat")) {
      const m = this.getModel();
      try {
        this.runTest(m);
        this._result = { status: "tested", model: m };
      } catch (e) {
        this._result = { status: "incorrect", model: m, error: e };
      }
    } else if (this._smtout && this._smtout.startsWith("unsat")) {
      this._result = { status: "verified" };
    } else {
      this._result = { status: "error", error: new Error("unexpected: " + this._smtout) };
    }
    return this._result;
  }

  solveLocal(): Promise<string> {
    const spawn = require('child_process').spawn;
    const p = spawn('/home/cs/Projects/jsfxs/z3/build/z3', ['-smt2', '-in'],
                    {stdio: ['pipe', 'pipe', 'ignore']});
    return new Promise((resolve, reject) => {
      let result: string = "";
      p.stdout.on('data', (data: Object) => {
         result += data.toString();
      });
      p.on('exit', (code: number) => resolve(result));
      p.stdin.write(this.smtInput());
      p.stdin.end();
    });
  }

  async solveRequest(): Promise<string> {
    const req = await fetch("/z3", {
      method: "POST",
      body: this.smtInput()
    });
    return req.text();
  }

  debugOut() { 
    console.log("\n" + this.description);
    console.log("-----------------");
    console.log(this._result);
    console.log("SMT Input:");
    console.log(this._smtin);
    console.log("SMT Output:");
    console.log(this._smtout);
    if (this._smtout && this._smtout.startsWith("sat")) {
      console.log("Test Body:");
      console.log(this.testCode());
    }
  }
}
