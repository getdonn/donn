import {
  CONNECTION_NAME_RULE,
  DONN_SLOT_PREFIX,
  SKILL_NAME_RULE,
  SLOT_NAME_MAX_LENGTH,
} from "@getdonn/adapter-sdk";

// How persona names become eve slot names. See docs/planning/24-adapter-eve.md, section 3 ("Names").

/**
 * The connection a persona MCP server becomes: lowercased, `_` as `-`, behind the `donn-` prefix,
 * or undefined when eve's rule (lowercase letters, digits and dashes, at most 64 with the prefix)
 * cannot take it.
 */
export function connectionName(serverName: string): string | undefined {
  const name = `${DONN_SLOT_PREFIX}${serverName.toLowerCase().replaceAll("_", "-")}`;
  return CONNECTION_NAME_RULE.test(name) && name.length <= SLOT_NAME_MAX_LENGTH
    ? name
    : undefined;
}

/** The skill directory a persona skill becomes: its name kept behind the prefix, or undefined. */
export function skillName(skill: string): string | undefined {
  const name = `${DONN_SLOT_PREFIX}${skill}`;
  return SKILL_NAME_RULE.test(name) && name.length <= SLOT_NAME_MAX_LENGTH
    ? name
    : undefined;
}
