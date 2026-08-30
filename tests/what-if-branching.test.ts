import { describe, it, expect } from 'vitest';
import { StoryBranchManager } from '@inkpi/agent-core';

describe('What-If Parallel Branch Timelines & Branch Summarization', () => {
  it('should initialize with main canon branch and allow creating parallel what-if branches', () => {
    const manager = new StoryBranchManager();
    expect(manager.getActiveBranchId()).toBe('main');

    const canonBranch = manager.getBranch('main');
    expect(canonBranch).toBeDefined();
    expect(canonBranch?.branchName).toContain('主线 (Mainline)');

    // Create a What-If branch
    const whatIf = manager.createWhatIfBranch(
      'demon_sect_branch',
      'Alternate Path A',
      'If hero joins Faction Z',
      {
        entities: [
          { name: 'UserE', status: 'Dark Disciple (Level 30)' },
          { name: 'Boss Z', status: 'Master (Level 90)' }
        ],
        assets: [{ name: 'Token A' }],
        tracks: [{ clue: '正道各宗密谋围剿Faction Z', status: 'pending' }],
        locations: [{ name: 'Dark Pit' }],
        modifiedDocuments: ['Document 10 Choice']
      }
    );

    expect(whatIf.branchId).toBe('demon_sect_branch');
    expect(manager.getAllBranches().length).toBe(2);
  });

  it('should accurately diff state ledgers between parallel branches', () => {
    const manager = new StoryBranchManager();

    const canonLedger = {
      entities: [
        { name: 'UserE', status: 'Main Disciple (Level 10)' },
        { name: 'UserF', status: 'Junior (Level 8)' }
      ],
      assets: [{ name: 'Token B' }, { name: 'Potion A' }],
      tracks: [
        { clue: 'Mystery of Mana', status: 'pending' },
        { clue: 'Secret of Pendant', status: 'pending' }
      ],
      locations: [{ name: 'Guild A' }],
      modifiedDocuments: ['Document 1', 'Document 2']
    };

    const demonLedger = {
      entities: [
        { name: 'UserE', status: 'Faction Leader (Level 20)' }, // Status changed
        { name: 'Guard B', status: 'Protector' } // New entity
      ],
      assets: [{ name: 'Cursed Flag' }, { name: 'Token B' }], // Added Cursed Flag
      tracks: [
        { clue: 'Mystery of Mana', status: 'resolved' }, // Resolved
        { clue: 'Secret Plan A', status: 'pending' } // New clue
      ],
      locations: [{ name: 'Base Z' }],
      modifiedDocuments: ['Document 1', 'Document 2', 'Document 3']
    };

    const diff = manager.diffLedgers(canonLedger, demonLedger);

    expect(diff.addedEntities).toContain('Guard B');
    expect(diff.changedEntityStatuses.length).toBe(1);
    expect(diff.changedEntityStatuses[0].name).toBe('UserE');
    expect(diff.changedEntityStatuses[0].from).toBe('Main Disciple (Level 10)');
    expect(diff.changedEntityStatuses[0].to).toBe('Faction Leader (Level 20)');

    expect(diff.addedAssets).toContain('Cursed Flag');
    expect(diff.newTracks).toContain('Secret Plan A');
    expect(diff.resolvedTracks).toContain('Mystery of Mana');
  });

  it('should switch branches and synthesize branch comparison summary', async () => {
    const manager = new StoryBranchManager();

    manager.updateActiveLedger({
      entities: [{ name: 'UserB', status: 'Novice' }],
      assets: [{ name: 'Basic Asset' }],
      tracks: [],
      locations: [],
      modifiedDocuments: []
    });

    manager.createWhatIfBranch(
      'branch_rebellion',
      'Exile Branch',
      '主角怒杀恶霸管事，连夜反出Guild A',
      {
        entities: [
          { name: 'UserB', status: 'Exile (Level 5)' },
          { name: 'Hunter', status: '敌对 (Level 20)' }
        ],
        assets: [{ name: 'Stolen Weapon' }],
        tracks: [{ clue: 'Bounty', status: 'pending' }],
        locations: [{ name: 'Old Forest' }],
        modifiedDocuments: ['Document 5 Escape']
      }
    );

    const switchResult = await manager.switchBranch('branch_rebellion');
    expect(switchResult.switched).toBe(true);
    expect(switchResult.branch.branchId).toBe('branch_rebellion');
    expect(switchResult.summary).toBeDefined();
    expect(switchResult.summary).toContain('分支切换');
    expect(switchResult.summary).toContain('Exile Branch');
    expect(switchResult.summary).toContain('UserB: Novice -> Exile (Level 5)');
    expect(manager.getActiveBranchId()).toBe('branch_rebellion');
  });
});
