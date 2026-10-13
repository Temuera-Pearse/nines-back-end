import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { NinesFinancialRaceResultClient,
  NinesFinancialRaceResultClientError } from './NinesFinancialRaceResultClient.js'
import { canonicalRaceResultJson, createRaceResultEvent, raceResultEvidenceHash,
  type NinesRaceResultAckV1, type NinesRaceResultV1 } from './raceResultContract.js'
import { RaceResultDeliveryWorker, type ClaimedRaceResult,
  type RaceResultOutboxRepository } from './raceResultOutbox.js'
import type { NinesRaceLifecycleEventV1 } from './raceLifecycleContract.js'

const fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(),
  'contracts/nines-race-result-v1.fixtures.json'), 'utf8')) as Record<string, NinesRaceResultV1>
const lifecycleFixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(),
  'contracts/nines-race-lifecycle-v1.fixtures.json'), 'utf8')) as Record<string, NinesRaceLifecycleEventV1>
const secret = 'w3-backend-financial-test-secret-at-least-32-characters'

function ack(event: NinesRaceResultV1, result: 'settled'|'replayed'='settled'):
NinesRaceResultAckV1 {
  return { schemaVersion:'nines-race-result-ack.v1',resultType:'nines_race_result_ack',result,
    raceId:event.raceId,raceRef:event.raceRef,resultId:event.resultId,resultVersion:1,
    settlementRunId:'settlement_run_fixture',poolStatus:'settled',totalPoolMinor:'100000000',
    acceptedStakeMinor:'100000000',appliedCarryoverMinor:'0',houseTakeMinor:'10000000',
    netPoolMinor:'90000000',roundingResidualMinor:'0',carryoverMinor:'0',
    settledAt:event.completedAt,correlationId:event.correlationId }
}

describe('authenticated authoritative race result contract and delivery', () => {
  it('constructs stable result identity and exact canonical evidence from W2 close evidence', () => {
    const event=createRaceResultEvent({ closeEvent:lifecycleFixture.validClose!,
      completedAt:'2026-04-22T12:00:50.000Z',winnerId:'horse-1',
      finishOrder:['horse-1','horse-2','horse-3'],
      raceChecksum:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' })
    expect(event).toEqual(fixture.validResult)
    expect(fixture.replay).toEqual(event)
    const {evidenceHash:_hash,...conflict}=fixture.conflict!
    expect(raceResultEvidenceHash(conflict)).toBe(fixture.conflict!.evidenceHash)
    expect(fixture.conflict!.resultId).toBe(event.resultId)
    expect(fixture.conflict!.evidenceHash).not.toBe(event.evidenceHash)
  })

  it('rejects a winner or finish order outside the authoritative W2 runner set', () => {
    const common={ closeEvent:lifecycleFixture.validClose!,
      completedAt:'2026-04-22T12:00:50.000Z',
      raceChecksum:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }
    expect(()=>createRaceResultEvent({...common,winnerId:'horse-9',
      finishOrder:['horse-9','horse-2','horse-3']})).toThrow('runner')
    expect(()=>createRaceResultEvent({...common,winnerId:'horse-1',
      finishOrder:['horse-1','horse-2']})).toThrow('each authoritative runner')
  })

  it('retries an identical result body with fresh HMAC nonces after response loss', async () => {
    const requests:Array<{body:string;nonce:string;hash:string}>=[]; let sequence=0
    const fetcher=vi.fn(async(_url:URL|RequestInfo,init?:RequestInit)=>{
      const headers=init?.headers as Record<string,string>
      requests.push({body:String(init?.body),nonce:headers['x-nines-request-id'],
        hash:headers['x-nines-content-sha256']})
      if(requests.length===1) throw new TypeError('response lost')
      return new Response(JSON.stringify(ack(fixture.validResult!,'replayed')),{status:200})
    }) as typeof fetch
    const client=new NinesFinancialRaceResultClient({baseUrl:'http://financial.test',
      environment:'test',keyId:'backend-result-v1',secret,fetchImplementation:fetcher,
      clock:()=>new Date('2026-04-22T12:00:51.000Z'),requestIdFactory:()=>sequence++===0?
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      maxAttempts:2})
    await expect(client.deliver(fixture.validResult!)).resolves.toMatchObject({result:'replayed'})
    expect(requests).toHaveLength(2)
    expect(requests[0]?.body).toBe(requests[1]?.body)
    expect(requests[0]?.body).toBe(canonicalRaceResultJson(fixture.validResult!))
    expect(requests[0]?.nonce).not.toBe(requests[1]?.nonce)
    expect(requests[0]?.hash).toBe(createHash('sha256').update(requests[0]!.body).digest('hex'))
  })

  it('classifies an exceeded Financial request deadline as a retryable timeout', async () => {
    const fetcher=vi.fn(async(_url:URL|RequestInfo,init?:RequestInit)=>
      new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>
        reject(new DOMException('aborted','AbortError'))))) as typeof fetch
    const client=new NinesFinancialRaceResultClient({baseUrl:'http://financial.test',
      environment:'test',keyId:'backend-result-v1',secret,fetchImplementation:fetcher,
      timeoutMs:1,maxAttempts:1})
    await expect(client.deliver(fixture.validResult!)).rejects.toMatchObject({
      code:'FINANCIAL_TIMEOUT',retryable:true,status:null})
  })

  it('accepts settled/replayed acknowledgements, rejects conflicts, and requires production HTTPS', async()=>{
    for(const result of ['settled','replayed'] as const){
      const fetcher=vi.fn(async()=>new Response(JSON.stringify(ack(fixture.validResult!,result)),
        {status:result==='settled'?201:200})) as typeof fetch
      const client=new NinesFinancialRaceResultClient({baseUrl:'http://financial.test',
        environment:'test',keyId:'key',secret,fetchImplementation:fetcher})
      await expect(client.deliver(fixture.validResult!)).resolves.toMatchObject({result})
    }
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({error:{
      code:'RACE_RESULT_IDENTITY_CONFLICT',retryable:false}}),{status:409})) as typeof fetch
    const client=new NinesFinancialRaceResultClient({baseUrl:'http://financial.test',
      environment:'test',keyId:'key',secret,fetchImplementation:fetcher,maxAttempts:2})
    await expect(client.deliver(fixture.conflict!)).rejects.toMatchObject({
      code:'RACE_RESULT_IDENTITY_CONFLICT',retryable:false})
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(()=>new NinesFinancialRaceResultClient({baseUrl:'http://financial',
      environment:'production',keyId:'key',secret})).toThrow('HTTPS')
  })

  it('keeps a temporarily unfrozen Financial pool retryable', async () => {
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({error:{
      code:'RACE_RESULT_POOL_NOT_FROZEN',retryable:true}}),{status:409})) as typeof fetch
    const client=new NinesFinancialRaceResultClient({baseUrl:'http://financial.test',
      environment:'test',keyId:'key',secret,fetchImplementation:fetcher,maxAttempts:1})
    await expect(client.deliver(fixture.validResult!)).rejects.toMatchObject({
      code:'RACE_RESULT_POOL_NOT_FROZEN',retryable:true,status:409})
  })

  it('recovers durable result delivery after a worker restart',async()=>{
    class FakeRepository implements RaceResultOutboxRepository{
      deliveredAt:Date|null=null; failures=0; claimCount=0
      async claim():Promise<ClaimedRaceResult|null>{if(this.deliveredAt)return null;this.claimCount+=1
        return {event:fixture.validResult!,payloadHash:fixture.validResult!.evidenceHash,
          attemptCount:this.claimCount}}
      async delivered():Promise<void>{this.deliveredAt=new Date()}
      async failed():Promise<void>{this.failures+=1}
    }
    const repository=new FakeRepository()
    await new RaceResultDeliveryWorker(repository,{deliver:async()=>{
      throw new NinesFinancialRaceResultClientError('offline',true,null,'NETWORK')}},1).runOnce()
    await new RaceResultDeliveryWorker(repository,{deliver:async()=>ack(fixture.validResult!,'replayed')},1)
      .runOnce()
    expect(repository.failures).toBe(1);expect(repository.claimCount).toBe(2)
    expect(repository.deliveredAt).not.toBeNull()
  })

  it('terminalizes immutable Financial evidence conflicts',async()=>{
    class FakeRepository implements RaceResultOutboxRepository{
      retryable:boolean|null=null
      async claim():Promise<ClaimedRaceResult>{return {event:fixture.validResult!,
        payloadHash:fixture.validResult!.evidenceHash,attemptCount:1}}
      async delivered():Promise<void>{throw new Error('unexpected delivery')}
      async failed(_id:string,_hash:string,_now:Date,_error:string,retryable:boolean):Promise<void>{
        this.retryable=retryable
      }
    }
    const repository=new FakeRepository()
    await new RaceResultDeliveryWorker(repository,{deliver:async()=>{
      throw new NinesFinancialRaceResultClientError('conflict',false,409,
        'RACE_RESULT_IDENTITY_CONFLICT')}},1).runOnce()
    expect(repository.retryable).toBe(false)
  })
})
