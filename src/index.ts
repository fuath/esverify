import { Message, MessageException, log, unexpected } from './message';
import { Options, options, setOptions } from './options';
import { sourceAsJavaScript } from './parser';
import { resolveNames } from './scopes';
import { vcgenProgram } from './vcgen';
import VerificationCondition from './verification';

export { default as VerificationCondition } from './verification';
export { Message } from './message';
export { Position, SourceLocation } from './javascript';
export { Options } from './options';

export function verificationConditions (src: string, opts: Partial<Options> = {}):
                Message | Array<VerificationCondition> {
  setOptions(opts);
  try {
    const prog = sourceAsJavaScript(src);
    resolveNames(prog);
    return vcgenProgram(prog);
  } catch (e) {
    return e instanceof MessageException ? e.msg : unexpected(e);
  }
}

export async function verify (src: string, opts: Partial<Options> = {}): Promise<Array<Message>> {
  const vcs = verificationConditions(src, opts);
  if (!(vcs instanceof Array)) {
    if (!options.quiet) log(vcs);
    return [vcs];
  }
  const res: Array<Message> = [];
  for (const vc of vcs) {
    let m: Message;
    try {
      m = await vc.verify();
    } catch (e) {
      m = e instanceof MessageException ? e.msg : unexpected(e);
    }
    if (!options.quiet) log(m);
    res.push(m);
  }
  return res;
}
