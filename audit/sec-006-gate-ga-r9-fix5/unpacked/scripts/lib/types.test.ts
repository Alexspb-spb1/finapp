import { describe, it, expect } from 'vitest'
import { relationKey, splitRelationKey } from './types.ts'

// Independent audit fix #6 (2nd round): relationKey/splitRelationKey used to
// be built from a hand-chosen delimiter ("::") — this suite proves the
// CURRENT canonical-JSON-tuple encoding is collision-free even when
// companyId/uid themselves contain that exact delimiter, whitespace, or
// Unicode content.
describe('relationKey / splitRelationKey — collision-free encoding', () => {
  it('round-trips a plain pair', () => {
    const key = relationKey('co_a', 'u1')
    expect(splitRelationKey(key)).toEqual(['co_a', 'u1'])
  })

  it('two different pairs sharing "::" content never collide', () => {
    // Old delimiter-based scheme: relationKey('co', 'a::u1') === relationKey('co::a', 'u1')
    const keyA = relationKey('co', 'a::u1')
    const keyB = relationKey('co::a', 'u1')
    expect(keyA).not.toBe(keyB)
    expect(splitRelationKey(keyA)).toEqual(['co', 'a::u1'])
    expect(splitRelationKey(keyB)).toEqual(['co::a', 'u1'])
  })

  it('companyId/uid containing literal "::" round-trip correctly on their own', () => {
    const key = relationKey('co::weird::a', 'u::1')
    expect(splitRelationKey(key)).toEqual(['co::weird::a', 'u::1'])
  })

  it('companyId/uid containing spaces round-trip correctly and never collide across a shifted boundary', () => {
    const keyA = relationKey('co a', 'b u1')
    const keyB = relationKey('co a b', 'u1')
    expect(keyA).not.toBe(keyB)
    expect(splitRelationKey(keyA)).toEqual(['co a', 'b u1'])
    expect(splitRelationKey(keyB)).toEqual(['co a b', 'u1'])
  })

  it('companyId/uid containing Unicode (including emoji and combining marks) round-trip correctly', () => {
    const key = relationKey('компания_日本語_🏢', 'пользователь_😀')
    expect(splitRelationKey(key)).toEqual(['компания_日本語_🏢', 'пользователь_😀'])
  })

  it('companyId/uid containing JSON-significant characters (quotes, backslashes, brackets) round-trip correctly', () => {
    const key = relationKey('co"a\\b[1]', 'u"1\\2')
    expect(splitRelationKey(key)).toEqual(['co"a\\b[1]', 'u"1\\2'])
  })

  it('empty-string companyId/uid round-trip and never collide with a non-empty pair', () => {
    const empty = relationKey('', '')
    const nonEmpty = relationKey('co_a', 'u1')
    expect(empty).not.toBe(nonEmpty)
    expect(splitRelationKey(empty)).toEqual(['', ''])
  })

  it('splitRelationKey throws (never silently misparse) on a malformed key', () => {
    expect(() => splitRelationKey('not json at all')).toThrow()
    expect(() => splitRelationKey('["only-one-element"]')).toThrow()
    expect(() => splitRelationKey('["a", "b", "c"]')).toThrow()
    expect(() => splitRelationKey('[1, 2]')).toThrow()
  })

  it('produces distinct keys across a large randomized sample containing delimiter-like content', () => {
    const pairs: [string, string][] = [
      ['co_a', 'u1::u2'], ['co_a::u1', 'u2'], ['co', 'a::::b'], ['co::::a', 'b'],
      ['co a', 'u1'], ['co', 'a u1'], ['', 'co::a::u1'], ['co::a::u1', ''],
    ]
    const keys = pairs.map(([c, u]) => relationKey(c, u))
    expect(new Set(keys).size).toBe(keys.length)
    pairs.forEach(([c, u], i) => expect(splitRelationKey(keys[i]!)).toEqual([c, u]))
  })
})
