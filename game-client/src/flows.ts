export type NpcFlowRequires = {
    holds?: string[]
    notHolds?: string[]
    gear?: string[]
    notGear?: string[]
}

export type NpcFlow = {
    requires?: NpcFlowRequires
    messages: string[]
    grantHold?: string
    grantGear?: string
    fishingQuest?: string
    questStep?: string
    questId?: string
}

export type NpcOnComplete = {
    grantHold?: string
    grantGear?: string
    questStep?: string
    questId?: string
}

export function flowRequirementsMet(
    requires: NpcFlowRequires | undefined,
    holds: Set<string>,
    gear: Set<string> = new Set()
): boolean {
    if (!requires) return true

    if (requires.holds?.some((item) => !holds.has(item))) {
        return false
    }

    if (requires.notHolds?.some((item) => holds.has(item))) {
        return false
    }

    if (requires.gear?.some((item) => !gear.has(item))) {
        return false
    }

    if (requires.notGear?.some((item) => gear.has(item))) {
        return false
    }

    return true
}

function flowRequirementScore(requires: NpcFlowRequires | undefined): number {
    if (!requires) return 0
    return (
        (requires.holds?.length || 0) +
        (requires.notHolds?.length || 0) +
        (requires.gear?.length || 0) +
        (requires.notGear?.length || 0)
    )
}

export function mergeFlowRequires(
    flowRequires?: NpcFlowRequires,
    extraRequires?: NpcFlowRequires
): NpcFlowRequires | undefined {
    const holds = new Set([...(flowRequires?.holds || []), ...(extraRequires?.holds || [])])
    const notHolds = new Set([...(flowRequires?.notHolds || []), ...(extraRequires?.notHolds || [])])
    if (!holds.size && !notHolds.size) {
        return flowRequires
    }
    return {
        holds: holds.size ? [...holds] : undefined,
        notHolds: notHolds.size ? [...notHolds] : undefined,
    }
}

/** Whether an NPC flow may grant its hold given map rules + catalog grant_requires. */
export function canGrantFlowHold(
    flow: NpcFlow,
    holds: Set<string>,
    holdGrantRules: Record<string, NpcFlowRequires> = {}
): boolean {
    if (!flow.grantHold) return true
    const catalogReq = holdGrantRules[flow.grantHold]
    const merged = mergeFlowRequires(flow.requires, catalogReq)
    return flowRequirementsMet(merged, holds)
}

export function matchNpcFlow(
    flows: NpcFlow[] | undefined,
    holds: Set<string>,
    holdGrantRules: Record<string, NpcFlowRequires> = {},
    gear: Set<string> = new Set()
): NpcFlow | null {
    if (!flows?.length) return null

    const matching = flows.filter((flow) => {
        if (!flow.messages?.length) return false
        if (!flowRequirementsMet(flow.requires, holds, gear)) return false
        if (flow.grantHold && !canGrantFlowHold(flow, holds, holdGrantRules)) return false
        return true
    })
    if (!matching.length) return null

    matching.sort((a, b) => {
        const scoreDiff = flowRequirementScore(b.requires) - flowRequirementScore(a.requires)
        if (scoreDiff !== 0) return scoreDiff
        const grantA = a.grantGear || a.grantHold ? 1 : 0
        const grantB = b.grantGear || b.grantHold ? 1 : 0
        return grantB - grantA
    })
    return matching[0]
}

export function resolveNpcMessages(
    defaultMessages: string[] | undefined,
    flows: NpcFlow[] | undefined,
    holds: Set<string>,
    holdGrantRules: Record<string, NpcFlowRequires> = {},
    gear: Set<string> = new Set()
): { messages: string[]; flow: NpcFlow | null } {
    const flow = matchNpcFlow(flows, holds, holdGrantRules, gear)
    if (flow?.messages?.length) {
        return { messages: flow.messages.filter(Boolean), flow }
    }

    return { messages: (defaultMessages || []).filter(Boolean), flow: null }
}

/** Stable id for a specific NPC message sequence (flow or default lines). */
export function hashMessageSet(messages: string[]): string {
    const normalized = messages.map((line) => line.trim()).filter(Boolean).join('\x1e')
    let hash = 0
    for (let i = 0; i < normalized.length; i++) {
        hash = (Math.imul(31, hash) + normalized.charCodeAt(i)) | 0
    }
    return Math.abs(hash).toString(36)
}

export function messageSetId(npcId: string, messages: string[]): string {
    return `npc:${npcId}:msgs:${hashMessageSet(messages)}`
}

export function filterInteractionForHolds(
    interaction: {
        pickupHold?: string
        options?: { label: string; code: string; hold?: string }[]
    },
    holds: Set<string>
): { skip: boolean; options: { label: string; code: string; hold?: string }[] } {
    const pickupHold = interaction.pickupHold?.trim()
    if (pickupHold && holds.has(pickupHold)) {
        return { skip: true, options: [] }
    }

    const options = (interaction.options || [])
        .map((option) => ({
            label: option.label.trim(),
            code: option.code.trim(),
            hold: option.hold?.trim() || undefined,
        }))
        .filter((option) => {
            if (!option.label || !option.code) return false
            if (option.hold && holds.has(option.hold)) return false
            return true
        })

    return { skip: false, options }
}
