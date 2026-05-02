import { describe, it, expect } from 'vitest';
import { sanitizeEntityName, validateRelationTypes, describesOtherPersonsHome } from '../knowledge-graph.js';

describe('sanitizeEntityName', () => {
  it('strips trailing markdown bold', () => {
    expect(sanitizeEntityName('Gerichtsentscheidung**')).toBe('Gerichtsentscheidung');
  });

  it('strips surrounding markdown bold', () => {
    expect(sanitizeEntityName('**Treffen Sonntag**')).toBe('Treffen Sonntag');
  });

  it('strips trailing punctuation', () => {
    expect(sanitizeEntityName('Purkersdorf:')).toBe('Purkersdorf');
    expect(sanitizeEntityName('München,')).toBe('München');
    expect(sanitizeEntityName('Wien.')).toBe('Wien');
  });

  it('strips backticks', () => {
    expect(sanitizeEntityName('`code`')).toBe('code');
  });

  it('returns null for empty after strip', () => {
    expect(sanitizeEntityName('**')).toBe(null);
    expect(sanitizeEntityName('***')).toBe(null);
    expect(sanitizeEntityName('')).toBe(null);
  });

  it('returns null for too short', () => {
    expect(sanitizeEntityName('a')).toBe(null);
  });

  it('preserves clean names unchanged', () => {
    expect(sanitizeEntityName('Maria Dohnal')).toBe('Maria Dohnal');
    expect(sanitizeEntityName('Sohn Linus')).toBe('Sohn Linus');
  });
});

describe('validateRelationTypes', () => {
  describe('person × person relations', () => {
    it('allows parent_of person→person', () => {
      expect(validateRelationTypes('person', 'person', 'parent_of')).toBe(true);
    });

    it('blocks parent_of person→organization', () => {
      expect(validateRelationTypes('person', 'organization', 'parent_of')).toBe(false);
    });

    it('blocks parent_of person→item (smarthome)', () => {
      expect(validateRelationTypes('person', 'item', 'parent_of')).toBe(false);
    });

    it('allows spouse, sibling, family between persons', () => {
      expect(validateRelationTypes('person', 'person', 'spouse')).toBe(true);
      expect(validateRelationTypes('person', 'person', 'sibling')).toBe(true);
      expect(validateRelationTypes('person', 'person', 'family')).toBe(true);
    });

    it('blocks family with non-person target', () => {
      expect(validateRelationTypes('person', 'organization', 'family')).toBe(false);
    });
  });

  describe('person × organization relations', () => {
    it('allows works_at person→organization', () => {
      expect(validateRelationTypes('person', 'organization', 'works_at')).toBe(true);
    });

    it('blocks works_at person→person ("User works_at Maria")', () => {
      expect(validateRelationTypes('person', 'person', 'works_at')).toBe(false);
    });

    it('blocks works_at person→item ("User works_at Gerichtsentscheidung")', () => {
      expect(validateRelationTypes('person', 'item', 'works_at')).toBe(false);
    });

    it('allows plays_at person→organization', () => {
      expect(validateRelationTypes('person', 'organization', 'plays_at')).toBe(true);
    });

    it('blocks plays_at person→location (a club is org, not location)', () => {
      expect(validateRelationTypes('person', 'location', 'plays_at')).toBe(false);
    });
  });

  describe('location-target relations', () => {
    it('allows located_at any→location', () => {
      expect(validateRelationTypes('person', 'location', 'located_at')).toBe(true);
      expect(validateRelationTypes('vehicle', 'location', 'located_at')).toBe(true);
      expect(validateRelationTypes('organization', 'location', 'located_at')).toBe(true);
    });

    it('blocks located_at any→non-location', () => {
      expect(validateRelationTypes('person', 'organization', 'located_at')).toBe(false);
      expect(validateRelationTypes('vehicle', 'item', 'located_at')).toBe(false);
    });

    it('allows home_location with location target', () => {
      expect(validateRelationTypes('person', 'location', 'home_location')).toBe(true);
      expect(validateRelationTypes('person', 'organization', 'home_location')).toBe(false);
    });
  });

  describe('same_as relation (identity)', () => {
    it('allows same_as same type', () => {
      expect(validateRelationTypes('person', 'person', 'same_as')).toBe(true);
      expect(validateRelationTypes('organization', 'organization', 'same_as')).toBe(true);
    });

    it('blocks same_as different types', () => {
      expect(validateRelationTypes('person', 'organization', 'same_as')).toBe(false);
      expect(validateRelationTypes('item', 'location', 'same_as')).toBe(false);
    });
  });

  describe('unknown / generic relations pass through', () => {
    it('allows knows, mentioned_with, uses with any types', () => {
      expect(validateRelationTypes('person', 'item', 'knows')).toBe(true);
      expect(validateRelationTypes('event', 'organization', 'mentioned_with')).toBe(true);
      expect(validateRelationTypes('person', 'item', 'uses')).toBe(true);
    });
  });
});

describe('describesOtherPersonsHome', () => {
  describe('positive matches (other person)', () => {
    it('detects mother/Mutter', () => {
      expect(describesOtherPersonsHome('Mutter wohnt in Eichgraben')).toBe(true);
      expect(describesOtherPersonsHome('mother lives in Vienna')).toBe(true);
    });

    it('detects father/Vater', () => {
      expect(describesOtherPersonsHome('Vater wohnt in Linz')).toBe(true);
      expect(describesOtherPersonsHome('father lives in Berlin')).toBe(true);
    });

    it('detects siblings', () => {
      expect(describesOtherPersonsHome('Schwester Elisabeth')).toBe(true);
      expect(describesOtherPersonsHome('Bruder ist in München')).toBe(true);
    });

    it('detects friends and colleagues', () => {
      expect(describesOtherPersonsHome('Freund Bernhard wohnt in Wien')).toBe(true);
      expect(describesOtherPersonsHome('Kollege ist in Tulln')).toBe(true);
    });

    it('detects grandparents (with and without umlaut)', () => {
      expect(describesOtherPersonsHome('Oma in Salzburg')).toBe(true);
      expect(describesOtherPersonsHome('Großmutter wohnt in Graz')).toBe(true);
      expect(describesOtherPersonsHome('grossmutter in Hamburg')).toBe(true);
    });

    it('detects neighbor / partner / spouse', () => {
      expect(describesOtherPersonsHome('Nachbar wohnt nebenan')).toBe(true);
      expect(describesOtherPersonsHome('Partner wohnt in Innsbruck')).toBe(true);
      expect(describesOtherPersonsHome('wife lives in Berlin')).toBe(true);
    });
  });

  describe('negative matches (user\'s own home)', () => {
    it('plain user address has no marker', () => {
      expect(describesOtherPersonsHome('User wohnt in 3033 Altlengbach')).toBe(false);
      expect(describesOtherPersonsHome('Adresse: Alleestraße 6, 3033 Altlengbach')).toBe(false);
    });

    it('home/work words alone do not trigger', () => {
      expect(describesOtherPersonsHome('home address')).toBe(false);
      expect(describesOtherPersonsHome('Büro in Wien')).toBe(false);
    });
  });

  describe('regression: the actual production bug', () => {
    it('mother address memory value triggers marker', () => {
      const value = 'Maria Dohnal (Mutter) wohnt in Adalbert Stifter Straße 4, 3032 Eichgraben.';
      expect(describesOtherPersonsHome(value)).toBe(true);
    });

    it('mother key alone triggers marker', () => {
      expect(describesOtherPersonsHome('mother_address_eichgraben')).toBe(true);
    });

    it('routing description with home reference does not trigger', () => {
      const value = 'Route: Vienna office → Linz → Altlengbach (~80 km outbound)';
      expect(describesOtherPersonsHome(value)).toBe(false);
    });
  });
});
