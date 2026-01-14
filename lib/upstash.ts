import { Redis } from '@upstash/redis';

// We are hardcoding this to bypass the "Missing URL" error
export const redis = new Redis({
  url: 'https://amazed-alien-25104.upstash.io', // Copy "REST URL" from Upstash
  token: 'AmIQAAIgcDHeIjPtUbRdkMNDwPgvgr7A5_pNKe-RVO2k1s0mgGMrnA', // Copy "REST Token" from Upstash
});
