# Relationship readiness

For a declaration on A targeting B, `blocked_by` (and legacy `depends_on`)
holds A until the local B is terminal. Local `blocks` holds B until A is
terminal. `parent` and `related` provide context without gating execution.

| Target shape | Local `blocked_by` / `depends_on` | Local `blocks` | External `blocked_by` / `depends_on` | External `blocks` | `parent` / `related` |
| --- | --- | --- | --- | --- | --- |
| Open B | Hold A | Hold B | Hold A | No local hold | No hold |
| Terminal B | Release A | Terminal B stays excluded | Hold A | No local hold | No hold |
| Missing B | Hold A with unknown target evidence | No visible B to hold | Hold A | No local hold | No hold |
| Self-reference | Hold A | Hold A | Hold A | No local hold | No hold |
| Two-way cycle | Hold both | Hold both | Hold both | No local hold | No hold |
| Duplicate declaration | One blocker | One blocker | One blocker | No local hold | No hold |
| Same-ID local and external declarations | Keep both namespaces | Only local edge gates B | Keep both namespaces | Only local edge gates B | No hold |

The source namespace is local when `source_kind` is omitted or `local`.
`global`, its `external` alias, and external URI targets refer to a separate
resource even if a local item has the same ID. A terminal local namesake cannot
resolve an external prerequisite. Only genuine local edges contribute dependent
ranking credit; same-ID local and external prerequisites count separately.

The scalar `blocked_by` field is supported alongside structured dependencies.
A scalar plus its identical structured local edge counts once; a local scalar
plus an external structured edge keeps both. The SDK `no-active-blocker`
sentinel creates no blocker.

`test/relationship-shapes.test.ts` exercises 152 cases through certified SDK
reads in real trackers outside git: all five kinds, four source spellings,
seven graph shapes, URI targets and scalar variants. Each case checks brief
and standalone next-work output; structured cases also check blocker evidence,
focus readiness, risks and ranking. Import fixtures preserve self-references
and duplicates that current mutation commands reject or normalize. No SDK
reader or tracker is mocked.

`test/sdk-semantics.test.ts` additionally verifies terminal `done` compatibility,
configured role precedence, custom terminal roles in native disclosure, and
same-ID blocker evidence and ranking before and after the local target closes.
