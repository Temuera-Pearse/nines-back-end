import { RaceState } from '../race/raceState.js';
import { getRaceRepository } from '../db/raceRepository.js';
import { getRaceArtifactRepository } from '../db/raceArtifactRepository.js';
import { getRaceArtifactLoader } from './raceArtifactLoader.js';
function normalizeFinishPayload(payload) {
    if (!payload?.raceId || !payload.winnerId)
        return null;
    const finishOrder = Array.isArray(payload.finishOrder)
        ? payload.finishOrder.filter((horseId) => typeof horseId === 'string')
        : [];
    const finishTimesMs = payload.finishTimesMs && typeof payload.finishTimesMs === 'object'
        ? payload.finishTimesMs
        : {};
    const finishTickIndex = payload.finishTickIndex && typeof payload.finishTickIndex === 'object'
        ? payload.finishTickIndex
        : {};
    const presentation = payload.presentation && typeof payload.presentation === 'object'
        ? {
            bannerVisibleUntilUtc: typeof payload.presentation.bannerVisibleUntilUtc === 'string'
                ? payload.presentation.bannerVisibleUntilUtc
                : '',
            resultsVisibleUntilUtc: typeof payload.presentation.resultsVisibleUntilUtc === 'string'
                ? payload.presentation.resultsVisibleUntilUtc
                : '',
        }
        : {
            bannerVisibleUntilUtc: '',
            resultsVisibleUntilUtc: '',
        };
    return {
        raceId: payload.raceId,
        timestampUtc: typeof payload.timestampUtc === 'string' ? payload.timestampUtc : '',
        winnerId: payload.winnerId,
        finishOrder,
        finishTimesMs,
        finishTickIndex,
        presentation,
        winner: payload.winnerId,
        placements: [...finishOrder],
    };
}
function mapRaceRecordToSummary(record) {
    const trackLength = Number(record.config.trackLength ?? 0);
    const finishRatio = Number(record.config.finishRatio ?? 1);
    return {
        raceId: record.raceId,
        config: record.config,
        finishLine: Number.isFinite(trackLength) && Number.isFinite(finishRatio)
            ? trackLength * finishRatio
            : null,
        startTime: record.actualStartTime,
        endTime: record.actualEndTime,
        winnerId: record.winnerId,
        finishOrder: record.finishOrder,
        finishTimesMs: record.finishTimesMs,
        checksum: record.checksum,
        lifecycleStatus: record.lifecycleStatus,
        persistenceStatus: record.persistenceStatus,
    };
}
export class DefaultRaceReadService {
    raceRepository = getRaceRepository();
    raceArtifactRepository = getRaceArtifactRepository();
    artifactLoader = getRaceArtifactLoader();
    async getCurrentRaceSummary() {
        const record = await this.raceRepository.findCurrentRace();
        return record ? mapRaceRecordToSummary(record) : null;
    }
    async getPreviousRaceSummary() {
        const record = await this.raceRepository.findPreviousRace();
        return record ? mapRaceRecordToSummary(record) : null;
    }
    async getRaceHistory(limit) {
        const records = await this.raceRepository.listRaceHistory(limit);
        return records.map(mapRaceRecordToSummary);
    }
    async getRaceResults(raceId) {
        const summaryArtifact = await this.findArtifact(raceId, 'summary');
        if (summaryArtifact) {
            const summary = await this.artifactLoader.loadJson(summaryArtifact);
            const fromSummary = normalizeFinishPayload(summary.authoritativeFinish);
            if (fromSummary)
                return fromSummary;
        }
        const record = await this.raceRepository.findRaceById(raceId);
        if (!record)
            return null;
        return {
            raceId: record.raceId,
            winnerId: record.winnerId,
            finishOrder: record.finishOrder,
            finishTimesMs: record.finishTimesMs,
            finishTickIndex: {},
            presentation: {
                bannerVisibleUntilUtc: '',
                resultsVisibleUntilUtc: '',
            },
            winner: record.winnerId,
            placements: [...record.finishOrder],
        };
    }
    async getTimeline(raceId) {
        const pre = RaceState.findPrecomputedById(raceId);
        if (pre?.eventTimeline) {
            const out = [];
            for (const [tickIndex, events] of pre.eventTimeline.entries()) {
                out.push({
                    tick: tickIndex,
                    events: events.map((event) => ({
                        id: event.id,
                        instanceId: event.instanceId,
                    })),
                });
            }
            out.sort((left, right) => left.tick - right.tick);
            return out;
        }
        const artifact = await this.findArtifact(raceId, 'event_timeline');
        if (!artifact)
            return null;
        return this.artifactLoader.loadJson(artifact);
    }
    async getFinalTicks(raceId) {
        const pre = RaceState.findPrecomputedById(raceId);
        if (pre?.finalHorseStateMatrix) {
            return pre.finalHorseStateMatrix.map((states, index) => ({
                tickIndex: index,
                positions: states.map((state) => state.position),
            }));
        }
        const artifact = await this.findArtifact(raceId, 'final_horse_state_matrix');
        if (!artifact)
            return null;
        const matrix = await this.artifactLoader.loadJson(artifact);
        return matrix.map((states, index) => ({
            tickIndex: index,
            positions: states.map((state) => Number(state.position ?? 0)),
        }));
    }
    async getRawTicks(raceId) {
        const pre = RaceState.findPrecomputedById(raceId);
        if (pre?.ticks)
            return pre.ticks;
        const artifact = await this.findArtifact(raceId, 'raw_ticks');
        if (!artifact)
            return null;
        return this.artifactLoader.loadJson(artifact);
    }
    async findArtifact(raceId, artifactType) {
        return this.raceArtifactRepository.findArtifact(raceId, artifactType);
    }
}
let sharedRaceReadService = null;
export function getRaceReadService() {
    if (!sharedRaceReadService) {
        sharedRaceReadService = new DefaultRaceReadService();
    }
    return sharedRaceReadService;
}
