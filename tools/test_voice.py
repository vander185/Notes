# Vérifie l'idée de l'empreinte vocale de Claire : découper « claire », le répéter, calculer l'empreinte Vosk.
import json, subprocess, sys, wave, numpy as np
from vosk import Model, KaldiRecognizer, SpkModel
RATE = 16000
model = Model(sys.argv[1]); spk = SpkModel(sys.argv[2]); G = '["claire", "[unk]"]'
def say(voice, pitch, speed):
    raw = subprocess.run(['espeak-ng', '-v', voice, '-p', str(pitch), '-s', str(speed), '--stdout', 'bonjour euh claire'], capture_output=True).stdout
    open('/tmp/a.wav', 'wb').write(raw)
    w = wave.open('/tmp/a.wav'); sr = w.getframerate(); a = np.frombuffer(w.readframes(w.getnframes()), np.int16)
    if sr != RATE: a = np.interp(np.arange(0, len(a), sr / RATE), np.arange(len(a)), a).astype(np.int16)
    return np.concatenate([np.zeros(RATE // 2, np.int16), a, np.zeros(RATE, np.int16)])
def embed(a):
    r = KaldiRecognizer(model, RATE, G); r.SetWords(True)
    res = None
    for i in range(0, len(a), 1600):
        if r.AcceptWaveform(a[i:i+1600].tobytes()): res = json.loads(r.Result()); break
    if res is None: res = json.loads(r.FinalResult())
    ws = [x for x in res.get('result', []) if x['word'] == 'claire']
    if not ws: return None, 'pas de claire: ' + json.dumps(res)[:80]
    s0 = int((ws[0]['start'] - .08) * RATE); s1 = int((ws[0]['end'] + .08) * RATE); word = a[max(0, s0):s1]
    reps = max(3, min(10, int(np.ceil(1.2 * RATE / len(word))))); gap = np.zeros(RATE // 20, np.int16)
    audio = np.concatenate([np.zeros(RATE // 5, np.int16)] + [np.concatenate([word, gap])] * reps + [np.zeros(RATE // 5, np.int16)])
    v = KaldiRecognizer(model, RATE, G); v.SetSpkModel(spk); v.AcceptWaveform(audio.tobytes())
    out = json.loads(v.FinalResult())
    if 'spk' not in out: return None, 'pas de spk (%d répétitions, mot %.2fs)' % (reps, len(word) / RATE)
    e = np.array(out['spk']); return e / np.linalg.norm(e), 'ok %.2fs x%d frames=%s' % (len(word) / RATE, reps, out.get('spk_frames'))
A = [embed(say('fr', p, s)) for p, s in [(40, 160), (45, 170), (38, 150), (42, 175), (40, 165), (44, 155)]]
for e, m in A: print('voix A', m)
B = [embed(say('fr+f3', p, s)) for p, s in [(70, 160), (75, 170), (68, 150)]]
for e, m in B: print('voix B', m)
okA = [e for e, _ in A if e is not None]
if okA:
    mean = np.mean(okA, 0); mean /= np.linalg.norm(mean)
    print('A vs empreinte A:', [round(float(e @ mean), 3) for e in okA])
    print('B vs empreinte A:', [round(float(e @ mean), 3) if e is not None else None for e, _ in B])
