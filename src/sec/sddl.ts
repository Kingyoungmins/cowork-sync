// SEC-20's SDDL reading (12-visualizer section 3.2 item 2; X-62, F-8a-2): the owner and the DACL of an SDDL string as SIDs, and the user-only
// verdict. Moved unchanged from src/viz/cli/dataDir.ts, which re-exports the public names; imports nothing.

export const BUILTIN_ADMINISTRATORS = 'S-1-5-32-544';
export const LOCAL_SYSTEM = 'S-1-5-18';
/** The one allowed-SID constant: the system SIDs (besides the user's own) an allow ACE of a user-only DACL may name. */
export const ALLOWED_SYSTEM_SIDS: readonly string[] = [LOCAL_SYSTEM, BUILTIN_ADMINISTRATORS];

/**
 * The owner and the DACL of an SDDL string, as SIDs: the aliases map to their SIDs (SY → S-1-5-18, BA → S-1-5-32-544, …); an allow ACE
 * for CREATOR OWNER or OWNER RIGHTS that is inherit-only is kept as 'CO' or 'OW' (it grants nothing on the directory itself and only
 * names whoever owns a child), while the same ACE without IO keeps its SID (S-1-3-0, S-1-3-4). Every other ACE, inherit-only or
 * not, counts by its SID: an inherit-only foreign allow reaches every file created inside.
 */
export interface Sddl { owner: string | null; allow: string[]; deny: string[]; }

const SID_RE = /^S-1-[0-9]+(?:-[0-9]+)+$/;
const ALIAS_RE = /^[A-Z]{2}$/;
const ALIASES: Readonly<Record<string, string>> = {
  SY: LOCAL_SYSTEM, BA: BUILTIN_ADMINISTRATORS, WD: 'S-1-1-0', AU: 'S-1-5-11', BU: 'S-1-5-32-545', BG: 'S-1-5-32-546',
  IU: 'S-1-5-4', NU: 'S-1-5-2', AN: 'S-1-5-7', LS: 'S-1-5-19', NS: 'S-1-5-20', CO: 'S-1-3-0', CG: 'S-1-3-1', OW: 'S-1-3-4',
};
const CREATOR_OWNER = 'S-1-3-0';
const OWNER_RIGHTS = 'S-1-3-4';
const ACE_FLAG_RE = /^(?:CI|OI|NP|IO|ID|SA|FA|TP|CR)*$/;
const RIGHTS_RE = /^(?:0[xX][0-9A-Fa-f]+|[0-9]+|(?:[A-Z]{2})+)$/;
/** A SID, or exactly two capital letters (an alias), at the start of the rest of an owner or group section. */
const SID_TOKEN_RE = /^(?:S-1-[0-9]+(?:-[0-9]+)+|[A-Z]{2})/;
/** ACL control flags, longest first. */
const ACL_FLAGS_RE = /^(?:NO_ACCESS_CONTROL|AI|AR|P)*/;

/** A SID or a two-letter alias, as a SID (an unknown alias stays the alias: it is no SID any rule admits). */
function sidOf(token: string): string | null {
  if (SID_RE.test(token)) return token;
  if (ALIAS_RE.test(token)) return ALIASES[token] ?? token;
  return null;
}

interface Acl { flags: string; aces: string[]; }

/**
 * The sections of an SDDL string, in the grammar O:<sid> G:<sid> D:<flags>(ace)… S:<flags>(ace)… (any order, each at most once);
 * ACE bodies are taken with their parentheses balanced (a conditional ACE nests them). Null when anything is left unread.
 */
function sections(sddl: string): { owner?: string; group?: string; dacl?: Acl; sacl?: Acl } | null {
  const out: { owner?: string; group?: string; dacl?: Acl; sacl?: Acl } = {};
  const seen = new Set<string>();
  let i = 0;
  while (i < sddl.length) {
    const tag = sddl[i] as string;
    if (!'OGDS'.includes(tag) || sddl[i + 1] !== ':' || seen.has(tag)) return null;
    seen.add(tag);
    i += 2;
    if (tag === 'O' || tag === 'G') {
      const m = SID_TOKEN_RE.exec(sddl.slice(i));
      if (m === null) return null;
      if (tag === 'O') out.owner = m[0];
      else out.group = m[0];
      i += m[0].length;
      continue;
    }
    const flags = (ACL_FLAGS_RE.exec(sddl.slice(i)) as RegExpExecArray)[0];
    i += flags.length;
    const aces: string[] = [];
    while (sddl[i] === '(') {
      let depth = 0;
      let j = i;
      for (; j < sddl.length; j += 1) {
        if (sddl[j] === '(') depth += 1;
        else if (sddl[j] === ')' && --depth === 0) break;
      }
      if (j >= sddl.length) return null;
      aces.push(sddl.slice(i + 1, j));
      i = j + 1;
    }
    if (tag === 'D') out.dacl = { flags, aces };
    else out.sacl = { flags, aces };
  }
  return out;
}

/** parseSddl's result, plus for each allow ACE (same order) whether it is inherited (the ID flag: it came from the parent's DACL). */
export interface SddlAces extends Sddl { allowInherited: boolean[]; }

export function parseSddlAces(sddl: string): SddlAces | null {
  const s = sections(sddl);
  if (s === null || s.dacl === undefined || s.dacl.flags.includes('NO_ACCESS_CONTROL')) return null;
  const owner = s.owner === undefined ? null : sidOf(s.owner);
  if (s.group !== undefined && sidOf(s.group) === null) return null;
  const aces = s.dacl.aces;

  const allow: string[] = [];
  const allowInherited: boolean[] = [];
  const deny: string[] = [];
  for (const ace of aces) {
    const f = ace.split(';');
    if (f.length !== 6) return null;
    const [type, aceFlags, rights, objectGuid, inheritGuid, sidToken] = f as [string, string, string, string, string, string];
    if (type !== 'A' && type !== 'D') return null;
    if (!ACE_FLAG_RE.test(aceFlags) || aceFlags.length % 2 !== 0 || !RIGHTS_RE.test(rights) || objectGuid !== '' || inheritGuid !== '') return null;
    const sid = sidOf(sidToken);
    if (sid === null) return null;
    if (type === 'D') {
      deny.push(sid);
      continue;
    }
    const flags: readonly string[] = aceFlags.match(/../g) ?? [];
    const inheritOnly = flags.includes('IO');
    allow.push(inheritOnly && sid === CREATOR_OWNER ? 'CO' : inheritOnly && sid === OWNER_RIGHTS ? 'OW' : sid);
    allowInherited.push(flags.includes('ID'));
  }
  return { owner, allow, deny, allowInherited };
}

/** null for malformed SDDL, an absent DACL (no D: part), D:NO_ACCESS_CONTROL, or any ACE type other than A and D (OA, XA, ZA, …) (S9). */
export function parseSddl(sddl: string): Sddl | null {
  const s = parseSddlAces(sddl);
  return s === null ? null : { owner: s.owner, allow: s.allow, deny: s.deny };
}


/**
 * A SID of an Sddl as the user sees it: the machine-relative aliases LA (the built-in Administrator, RID 500) and LG (the built-in Guest,
 * RID 501) are the user exactly when the user's SID has that RID (Windows prints the account's own SID as the alias; the machine SID is
 * the user SID without its RID). Any other LA/LG names another account and stays the alias, which no rule admits. A domain account with
 * RID 500 also reads LA as itself; LA is then the local Administrator, a member of BUILTIN\Administrators, which is admitted anyway.
 */
export function asUser(sid: string | null, user: string): string | null {
  const rid = user.slice(user.lastIndexOf('-') + 1);
  return (sid === 'LA' && rid === '500') || (sid === 'LG' && rid === '501') ? user : sid;
}

/** owner ∈ {user, S-1-5-32-544} (LA/LG read per asUser); `user` upper case. */
export function ownerOk(owner: string | null, user: string): boolean {
  const o = asUser(owner, user);
  return o === user || o === BUILTIN_ADMINISTRATORS;
}

/** The SEC-20 owner rule verifyDataDir and sddlUserOnly apply: the owner is the user or BUILTIN\Administrators, LA/LG being the user when
 *  the user is that account (the owner probe's test asserts with it). */
export function sddlOwnerOk(owner: string | null, userSid: string): boolean {
  return ownerOk(owner, userSid.toUpperCase());
}

/** The SIDs an allow ACE may name: the user, SY, BA, and inherit-only CREATOR OWNER / OWNER RIGHTS (as parseSddl writes them). */
export const admittedSids = (user: string): ReadonlySet<string> => new Set([user, ...ALLOWED_SYSTEM_SIDS, 'CO', 'OW']);

/** owner ∈ {user, S-1-5-32-544}; at least one allow ACE for the user SID; every allow ACE ∈ {user, S-1-5-18, S-1-5-32-544}; inherit-only CO/OW
 *  allowed; LA and LG count as the user when the user is that account (asUser). */
export function sddlUserOnly(s: Sddl, userSid: string): boolean {
  const user = userSid.toUpperCase();
  if (!ownerOk(s.owner, user)) return false;
  const allow = s.allow.map((sid) => asUser(sid, user));
  if (!allow.includes(user)) return false;
  const admitted = admittedSids(user);
  return allow.every((sid) => sid !== null && admitted.has(sid));
}
