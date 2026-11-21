// Driver for the csv-reader-speed-01 entry. The harness runs `node main.ts`:
// it reads the cases from the input directory, answers each one with run()
// from solve.js, and writes the answers to the output directory, one per case
// and in the cases' order. Outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// Two measured choices shape this driver (both won head-to-head benchmarks on
// the practice set, fresh process per run, as the heat runs):
//
//   1. V8 flags: incremental marking off, single-threaded. The entry allocates
//      millions of short-lived strings per case; incremental marking's write
//      barriers cost more than they save here, and on one CPU the background
//      compiler thread only steals time from the work itself.
//   2. A JIT warm-up before the real cases. Each heat run is a fresh process,
//      and run() is called only six times per process — too few for the
//      optimizing compiler to learn the code before the timed work is done.
//      Parsing a small branch-complete set of synthetic inputs first (every
//      path in run(), both header values, with and without BOM) lets the
//      compiler optimize run() up front. The warm-up inputs are synthetic,
//      their answers are discarded, and every case is still answered alone by
//      a fresh run() call — nothing is cached from one case to the next.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8 tuning, applied before solve.js is imported so all of its work runs
// under it.
setFlagsFromString('--no-incremental-marking --single-threaded');

type Solver = { run: (input: unknown) => unknown };
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as Solver;

// --- JIT warm-up (see the header note) ---
const warmBody =
  'id,name,note,price\r\n' +
  '1,alpha,plain,10\r\n' +
  '2,"quoted, field","has ""doubled"" quotes",20\n' +
  '3,"multi\nline",x,30\r\n' +
  '4,"junk"after,trailing,40\n' +
  '5,stray\rcr,here,50\n' +
  '6,short\n' +
  '7,long,row,with,extra,fields,here\n' +
  '8,,empty,70\r\n' +
  '\n' +
  '9,ünïcödé,😀 emoji,80\r\n' +
  '10,"cr\rin quotes",done,90\n' +
  '11,"q"\r,z,100\n' +
  '12,"never closes\r';
const warmInputs = [
  { text: '\uFEFF' + warmBody, header: true },
  { text: warmBody, header: false },
  { text: warmBody, header: true },
  { text: '\uFEFF' + warmBody, header: false },
  { text: '', header: true },
  { text: '', header: false },
  { text: 'a,b\n\r', header: true },
  { text: '\r\n\r\n', header: false },
];
for (let i = 0; i < 2000; i++) run(warmInputs[i % warmInputs.length]);

// --- The real cases ---
const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; input: unknown };
const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];

const answers: unknown[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  answers[i] = run(cases[i].input);
}

writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
