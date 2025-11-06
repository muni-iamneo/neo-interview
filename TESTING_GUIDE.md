# Testing Guide: Streaming API vs Standard API

## 🎯 Objective

Compare performance between:
1. **Streaming API** (current, fast, recommended)
2. **Standard API** (new, slower, for testing)

---

## 📋 Prerequisites

1. Install new dependency:
```bash
cd backend
pip install requests==2.32.3
```

2. Make sure you have properly restarted backend (no cached code):
```bash
# Kill all Python processes
pkill -f "uvicorn backend.main:app"

# Clear cache (already done, but just in case)
find backend -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
```

---

## 🧪 Test 1: Baseline (Streaming API - Current)

### Step 1: Configure for Streaming

Make sure your `.env` does NOT have `ASSEMBLYAI_USE_STANDARD_API=true`:

```bash
# Check current config
grep ASSEMBLYAI_USE_STANDARD_API backend/.env

# If it exists and is true, comment it out or set to false:
# ASSEMBLYAI_USE_STANDARD_API=false
```

**Or simply don't set it** - defaults to `false` (streaming).

### Step 2: Start Backend

```bash
cd backend
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

### Step 3: Check Logs on Startup

You should see:
```
[Custom Provider] Loading STT (AssemblyAI Streaming (WebSocket))...
[AssemblyAI STT] Connecting to streaming API v3...
[AssemblyAI STT] Connected successfully
```

### Step 4: Test Short Utterance

**Say:** "Hello"

**Expected logs:**
```
[AssemblyAI STT] Turn: 'hello' (end_of_turn=False)
[AssemblyAI STT] Turn: 'hello' (end_of_turn=True)
[AssemblyAI STT] Sending transcript (end_of_turn, 1 words): 'hello'
[Azure Realtime LLM] Received transcript: 'hello'
[Azure Realtime LLM] Response generated in 1234ms
[Kokoro TTS] Synthesizing: 'Hi! How are you doing?'
```

**Measure latency:**
- From when you stop speaking to when agent starts responding
- Expected: **2.5-3.5 seconds** ✅

### Step 5: Test Long Utterance

**Say:** "I have 5 years of experience in Python and Django"

**Expected logs:**
```
[AssemblyAI STT] Turn: 'i have' (end_of_turn=False)
[AssemblyAI STT] Turn: 'i have 5 years' (end_of_turn=False)
[AssemblyAI STT] Turn: 'i have 5 years of experience' (end_of_turn=False)
[AssemblyAI STT] Turn: 'i have 5 years of experience in python' (end_of_turn=False)
[AssemblyAI STT] Turn: 'i have 5 years of experience in python and django' (end_of_turn=True)
[AssemblyAI STT] Sending transcript (end_of_turn, 10 words): 'i have 5 years of experience in python and django'
```

**Measure latency:**
- Expected: **2.8-3.5 seconds** after you stop speaking ✅

### Step 6: Record Results

| Metric | Result |
|--------|--------|
| Short utterance latency | ___ seconds |
| Long utterance latency | ___ seconds |
| Number of "Sending transcript" per utterance | ___ (should be 1) |
| Agent responses per utterance | ___ (should be 1) |
| User experience | Fast / Medium / Slow |

---

## 🧪 Test 2: Standard API (HTTP POST)

### Step 1: Configure for Standard API

Add to your `.env` or set environment variable:

```bash
# Option 1: Add to .env file
echo "ASSEMBLYAI_USE_STANDARD_API=true" >> backend/.env

# Option 2: Set environment variable
export ASSEMBLYAI_USE_STANDARD_API=true
```

### Step 2: Restart Backend (IMPORTANT)

**Must completely restart** for config change:

```bash
# Kill backend
pkill -f "uvicorn backend.main:app"

# Start fresh
cd backend
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

### Step 3: Check Logs on Startup

You should see:
```
[Custom Provider] Loading STT (AssemblyAI Standard (HTTP))...
[AssemblyAI Standard] Initialized (WARNING: High latency mode)
[AssemblyAI Standard] Using Standard API: Expect 1.5-3 second higher latency vs Streaming API
```

**If you don't see "Standard (HTTP)", the config didn't apply - restart again!**

### Step 4: Test Short Utterance

**Say:** "Hello"

**Expected logs:**
```
[AssemblyAI Standard] Speech detected, recording...
[AssemblyAI Standard] Silence detected (1.4s), uploading 0.8s of audio...
[AssemblyAI Standard] WAV file created: 45ms
[AssemblyAI Standard] Upload complete: 312ms
[AssemblyAI Standard] Transcription job created: 89ms
[AssemblyAI Standard] Transcription completed after 7 polls (2347ms total): 'hello'
[AssemblyAI Standard] Latency breakdown: File=45ms, Upload=312ms, Job=89ms, Poll=1901ms
```

**Measure latency:**
- From when you stop speaking to when agent starts responding
- Expected: **4.0-5.5 seconds** ❌ (noticeably slower)

### Step 5: Test Long Utterance

**Say:** "I have 5 years of experience in Python and Django"

**Expected logs:**
```
[AssemblyAI Standard] Speech detected, recording...
[AssemblyAI Standard] Silence detected (1.4s), uploading 4.2s of audio...
[AssemblyAI Standard] WAV file created: 78ms
[AssemblyAI Standard] Upload complete: 489ms
[AssemblyAI Standard] Transcription job created: 102ms
[AssemblyAI Standard] Transcription completed after 12 polls (2891ms total): 'i have 5 years...'
[AssemblyAI Standard] Latency breakdown: File=78ms, Upload=489ms, Job=102ms, Poll=2222ms
```

**Measure latency:**
- Expected: **5.0-7.0 seconds** after you stop speaking ❌ (much slower)

### Step 6: Record Results

| Metric | Result |
|--------|--------|
| Short utterance latency | ___ seconds |
| Long utterance latency | ___ seconds |
| Number of "Sending transcript" per utterance | ___ (should be 1) |
| Agent responses per utterance | ___ (should be 1) |
| User experience | Fast / Medium / Slow |

---

## 📊 Comparison Table

Fill this out after both tests:

| Metric | Streaming API | Standard API | Difference |
|--------|---------------|--------------|------------|
| **Short utterance** | ___ seconds | ___ seconds | +___ seconds |
| **Long utterance** | ___ seconds | ___ seconds | +___ seconds |
| **STT latency** | 0.7-0.8s | 1.7-3.0s | +1-2.2s |
| **Total E2E** | 2.5-3.5s | 4.0-6.0s | +1.5-2.5s |
| **User experience** | ✅ Natural | ❌ Slow | Worse |
| **Complexity** | Medium | Medium | Similar |
| **Accuracy** | 95-98% | 96-99% | +1-2% (marginal) |

---

## 🎯 Expected Conclusions

### What You Should Observe:

1. **Latency:** Standard API is 1.5-2.5 seconds slower per response
2. **User experience:** Streaming feels natural, Standard feels laggy
3. **Accuracy:** Both are very accurate (~95-99%)
4. **Reliability:** Both should work correctly (1 transcript per utterance)

### Performance Breakdown:

**Streaming API:**
```
Speech ends → 500ms silence → 200ms processing → STT done
Total STT: 700-800ms ✅
```

**Standard API:**
```
Speech ends → 1400ms silence → 50ms file → 300ms upload → 1000ms process → STT done
Total STT: 2750ms ❌
```

**Difference:** +1,950ms (almost 2 full seconds!) ❌

---

## 🚨 Troubleshooting

### Issue: Still using Streaming API after switching config

**Symptoms:**
- Logs show "Streaming (WebSocket)" not "Standard (HTTP)"
- Fast latency even with `ASSEMBLYAI_USE_STANDARD_API=true`

**Solution:**
```bash
# Verify config is set
python -c "from app.core.config import settings; print(f'Standard API: {settings.ASSEMBLYAI_USE_STANDARD_API}')"

# If showing False, check .env file:
cat backend/.env | grep ASSEMBLYAI_USE_STANDARD_API

# Make sure it's set to true (no quotes needed):
ASSEMBLYAI_USE_STANDARD_API=true

# Completely restart backend
pkill -9 python
cd backend && uvicorn backend.main:app --reload
```

### Issue: Import error for 'requests'

**Symptoms:**
```
ImportError: No module named 'requests'
```

**Solution:**
```bash
pip install requests==2.32.3
```

### Issue: High latency in both tests

**Symptoms:**
- Both APIs taking 5+ seconds

**Possible causes:**
1. Network latency (check internet connection)
2. LLM slow (check Azure OpenAI status)
3. TTS slow (check Kokoro performance)
4. Server overloaded (check CPU/RAM)

**Debug:**
```bash
# Check component latencies in logs:
grep "ms" backend/logs/*.log | tail -20

# Look for:
# - STT: Should be 700-800ms (streaming) or 1700-3000ms (standard)
# - LLM: Should be 1500-1800ms
# - TTS: Should be 600-900ms
```

---

## 🎯 Recommendation After Testing

After completing both tests, you should conclude:

**✅ KEEP STREAMING API** for production use because:
1. 40-60% lower latency
2. Better user experience
3. Natural conversation flow
4. Accuracy is already excellent (95-98%)

**❌ DO NOT USE STANDARD API** for real-time conversations because:
1. 2+ seconds additional latency is noticeable
2. Users will perceive system as slow
3. Conversation feels unnatural
4. Only 1-2% accuracy improvement (not worth it)

**When to use Standard API:**
- Batch transcription of recorded files
- Post-call analysis
- Non-real-time applications
- When accuracy is more important than speed

---

## 🔄 Switching Back to Streaming (Recommended)

After testing, switch back:

```bash
# Option 1: Remove from .env
sed -i '/ASSEMBLYAI_USE_STANDARD_API/d' backend/.env

# Option 2: Set to false
# Edit backend/.env:
ASSEMBLYAI_USE_STANDARD_API=false

# Option 3: Unset environment variable
unset ASSEMBLYAI_USE_STANDARD_API

# Restart backend
pkill -f "uvicorn backend.main:app"
cd backend && uvicorn backend.main:app --reload
```

**Verify streaming is active:**
```
[Custom Provider] Loading STT (AssemblyAI Streaming (WebSocket))...
```

---

## 📝 Testing Checklist

- [ ] Installed requests library
- [ ] Tested Streaming API (baseline)
- [ ] Recorded Streaming API metrics
- [ ] Configured Standard API
- [ ] Completely restarted backend
- [ ] Verified Standard API is active (logs show "Standard (HTTP)")
- [ ] Tested Standard API
- [ ] Recorded Standard API metrics
- [ ] Compared results
- [ ] Concluded Streaming is better
- [ ] Switched back to Streaming API
- [ ] Verified Streaming is active again

---

## 📊 Share Your Results

After testing, share:

1. **Latency comparison:** "Streaming: X.Xs, Standard: Y.Ys"
2. **User experience:** "Streaming felt natural, Standard felt slow"
3. **Logs:** First 30 lines from each test
4. **Conclusion:** "Keeping Streaming API because..."

---

**Created:** 2025-11-06
**Purpose:** Compare Streaming vs Standard API performance
**Expected outcome:** Confirm Streaming API is optimal for voice interviews ✅
