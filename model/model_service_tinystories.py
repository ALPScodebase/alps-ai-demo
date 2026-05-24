import os
import uuid
import time
import threading
import queue
import numpy as np
from contextlib import nullcontext
from flask import Flask, request, jsonify

# --- MODEL IMPORTS ---
import model_utils
import torch
from torch.utils.data import DataLoader
from dattri.benchmark.datasets.shakespeare_char.data import CustomDataset
from dattri.benchmark.models.nanoGPT.model import GPT, GPTConfig

APP_PORT = int(os.getenv("MODEL_SERVER_PORT", "9090"))
APP_HOST = os.getenv("MODEL_SERVER_HOST", "0.0.0.0")
MAX_NEW_TOKENS = int(os.getenv("MAX_OUTPUT_SIZE", "1800"))

TRAIN_DATASET_HOLDERS_PATH = "./nanoGPT_tinystories/holders.txt"
TRAIN_DATASET_PATH = "./nanoGPT_tinystories/data/tinystories/train.bin"
MODEL_LATENCY_FILE = "./nanoGPT_tinystories/model_latency.tsv"
META_PATH = "./nanoGPT_tinystories/data/tinystories/meta.pkl"
CHECKPOINT_PATH = "./nanoGPT_tinystories/out-tinystories/ckpt.pt"
BLOCK_SIZE = 128
BATCH_SIZE = 64
NUM_SAMPLES = 1
TOP_K_TOKENS = 200
TEMPERATURE = 0.8
DEVICE = "cpu"
SEED = 1337
NORM_FACTOR = 1e18
FILTER_POLICIES = ["TOP_VALUES", "TOP_HOLDERS"]
HOLDERS_MAP = np.loadtxt(TRAIN_DATASET_HOLDERS_PATH, dtype=int).tolist() # Load holders map.

# Global model variables
ctx = nullcontext()
torch.manual_seed(SEED)
np.random.seed(SEED)
train_data = np.memmap(TRAIN_DATASET_PATH, dtype=np.uint16, mode='r') # Load training dataset.
train_dataset = CustomDataset(train_data, BLOCK_SIZE)
train_loader = DataLoader(train_dataset, batch_size=BATCH_SIZE, shuffle=False)
encode_f, decode_f = model_utils.load_meta(META_PATH)
encode = encode_f
decode = decode_f
model = None
model_latency_map = None

app = Flask(__name__)

# SHARED MEMORY AND LOCK
JOBS = {}
jobs_lock = threading.Lock()
JOB_QUEUE = queue.Queue()
OUTPUTS = {}
outputs_lock = threading.Lock()

def load_latencies():
    model_latencies = np.loadtxt(MODEL_LATENCY_FILE, delimiter="\t", skiprows=1)
    sizes = []
    dicts = []
    for i in range(0, len(model_latencies)):
        sizes.append(int(model_latencies[i][0]))
        d = dict()
        d['gen_mean'] = float(model_latencies[i][1])
        d['gen_std'] = float(model_latencies[i][2])
        d['att_mean'] = float(model_latencies[i][3])
        d['att_std'] =  float(model_latencies[i][4])
        dicts.append(d)
    return dict(zip(sizes, dicts))

def get_attribution_time(num_tokens):
    if not num_tokens in model_latency_map:
        raise ValueError("[MODEL_SERVICE] [ERROR] Invalid number of tokens.")
    m = model_latency_map[num_tokens]['att_mean']
    s = model_latency_map[num_tokens]['att_std']
    mu = np.log(m**2 / np.sqrt(s**2 + m**2))
    sigma = np.sqrt(np.log(1 + (s**2 / m**2)))
    delay = np.random.lognormal(mean=mu, sigma=sigma)
    return delay

def load_model():
    global model
    checkpoint = torch.load(CHECKPOINT_PATH, map_location=DEVICE)
    gptconf = GPTConfig(**checkpoint['model_args'])
    model = GPT(gptconf)
    state_dict = checkpoint['model']
    unwanted_prefix = '_orig_mod.'
    for k,v in list(state_dict.items()):
        if k.startswith(unwanted_prefix):
            state_dict[k[len(unwanted_prefix):]] = state_dict.pop(k)
    model.load_state_dict(state_dict)
    model.eval()
    model.to(DEVICE)

def generate_text(prompt):
    start_ids = encode(prompt)
    x = (torch.tensor(start_ids, dtype=torch.long, device=DEVICE)[None, ...])
    with torch.no_grad():
        with ctx:
            y = model.generate(x, MAX_NEW_TOKENS, temperature=TEMPERATURE, top_k=TOP_K_TOKENS)
            return decode(y[0].tolist())

# --- ATTRIBUTION LOGIC ---
def compute_attribution(job_id):
    # For testing purposes, we can generate dummy attribution values 
    # instead of running the full TRAK pipeline.
    size = len(train_data) // BLOCK_SIZE
    values = np.random.exponential(1, size)
    values = values / values.sum()
    #np.savetxt(output_file, values.tolist())
    time.sleep(get_attribution_time(MAX_NEW_TOKENS))
    return values.tolist()

def process_attribution_scores(attribution_scores, filter_policy):
    # Apply filtering policy.
    combined = list(zip(HOLDERS_MAP, attribution_scores))
    results = None
    if filter_policy == "TOP_VALUES":
        # For TOP_VALUES, we keep all individual scores without aggregation.
        results = combined
    elif filter_policy == "TOP_HOLDERS":
        # For TOP_HOLDERS, we group by holder and sum holders' scores.
        count_dict = dict()
        for holder, score in combined:
            if holder in count_dict:
                count_dict[holder] += score
            else:
                count_dict[holder] = score
        results = list(count_dict.items())

    # Results should be sorted by holder id in ascending order.
    results = sorted(results, key=lambda item: item[0], reverse=False)
    # And then unpacked into separate lists.
    holder_ids, scores = zip(*results)
    # Convert scores to BigInts for blockchain compatibility.
    int_scores = []
    for s in scores:
        # Protection against NaN or Infinity
        if np.isnan(s) or np.isinf(s): 
            s = 0.0
        int_val = int(float(s) * NORM_FACTOR)
        int_scores.append(int_val)
    return list(holder_ids), list(int_scores)

def run_full_process(job_id, prompt, filter_policy, threshold):
    try:
        # A. Generation
        print(f"[MODEL_SERVICE] [JOB {job_id}] Step 1: Generating text...")
        start_time = time.time()
        output = generate_text(prompt)
        end_time = time.time() - start_time
        with outputs_lock:
            OUTPUTS[job_id]["result"] = output
            OUTPUTS[job_id]["status"] = "completed"
        print(f"[MODEL_SERVICE] [JOB {job_id}] Generation completed in {end_time:.2f} seconds.")

        # B. Attribution
        print(f"[MODEL_SERVICE] [JOB {job_id}] Step 2: Computing Attribution...")
        start_time = time.time()
        attribution_scores = compute_attribution(job_id)
        end_time = time.time() - start_time
        print(f"[MODEL_SERVICE] [JOB {job_id}] Attribution computed in {end_time:.2f} seconds.")

        # D. Read and Aggregate results
        print(f"[MODEL_SERVICE] [JOB {job_id}] Step 3: Reading and aggregating attribution results...")
        holder_ids, processed_scores = process_attribution_scores(attribution_scores, filter_policy)
        sorted_list = [[holder_id, str(score)] for holder_id, score in zip(holder_ids, processed_scores)]

        # E. Save Result
        with jobs_lock:
            JOBS[job_id]["result"] = {"sorted_list": sorted_list}
            JOBS[job_id]["status"] = "completed"

        print(f"[MODEL_SERVICE] [JOB {job_id}] COMPLETED SUCCESSFULLY!")

    except Exception as e:
        print(f"[MODEL_SERVICE] [JOB {job_id}] CRITICAL ERROR: {str(e)}")
        with jobs_lock:
            JOBS[job_id]["status"] = "error"
            JOBS[job_id]["error"] = str(e)
        with outputs_lock:
            if OUTPUTS[job_id]["status"] != "completed":
                OUTPUTS[job_id]["status"] = "error"
                OUTPUTS[job_id]["error"] = str(e)

# --- BACKGROUND WORKER (SEQUENTIAL EXECUTION) ---
def background_worker():
    """
    This thread runs in background and takes only one job at a time
    from the queue and execute the AI. This grants no parallel executions
    """
    while True:
        job_id, prompt, filter_policy, threshold = JOB_QUEUE.get()

        # Update the status to "processing" only when the job starts
        with jobs_lock:
            if job_id in JOBS:
                JOBS[job_id]["status"] = "processing"

        with outputs_lock:
            if job_id in OUTPUTS:
                OUTPUTS[job_id]["status"] = "processing"

        try:
            run_full_process(job_id, prompt, filter_policy, threshold)
        except Exception as e:
            print(f"[MODEL_SERVICE] [WORKER] Unexpected error for the job {job_id}: {e}")
        finally:
            # Alert the queue that this task is done, unlocking the next
            JOB_QUEUE.task_done()

# --- ENDPOINTS ---
@app.route('/attribute', methods=['POST'])
def attribute():
    data = request.json
    if not data or 'text' not in data:
        return jsonify({"error": "Missing 'text' field"}), 400

    # --- ROBUST ID LOGIC ---
    # Reads job_id (new standard) OR cid (old standard) OR creates one
    job_id = data.get('job_id') or data.get('cid') or str(uuid.uuid4())

    prompt = data['text']
    filter_policy = data.get('filter_policy', FILTER_POLICIES[0])
    threshold = data.get('threshold', 100)
    if filter_policy not in FILTER_POLICIES:
        return jsonify({"error": "Invalid filter policy"}), 400

    with jobs_lock:
        if job_id in JOBS:
            print(f"[MODEL_SERVICE] [DEDUPLICATION] Duplicate request for Job {job_id}. Ignoring.")
            return jsonify({
                "message": "Job already exists",
                "job_id": job_id,
                "status": JOBS[job_id]["status"]
            }), 200

        JOBS[job_id] = {"status": "queued", "result": None}
    
    with outputs_lock:
        OUTPUTS[job_id] = {"status": "queued", "result": None}

    print(f"[MODEL_SERVICE] [NEW] Queuing Job {job_id}")
    # QUEUE THE JOB 
    JOB_QUEUE.put((job_id, prompt, filter_policy, threshold))
    return jsonify({"message": "Job Queued", "job_id": job_id}), 202

@app.route('/result/<job_id>', methods=['GET'])
def get_result(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify(job), 200

@app.route('/output/<job_id>', methods=['GET'])
def get_output(job_id):
    output = OUTPUTS.get(job_id)
    if not output:
        return jsonify({"error": "Output not found"}), 404
    return jsonify(output), 200

if __name__ == '__main__':
    # Load model latencies.
    model_latency_map = load_latencies()
    print("[MODEL_SERVICE] Model latencies loaded successfully!")
    # Load the model.
    load_model()
    print("[MODEL_SERVICE] Model loaded successfully!")
    print(f"[MODEL_SERVICE] Supporting queries producing {MAX_NEW_TOKENS} tokens")
    # Start the background worker before exposing the API
    threading.Thread(target=background_worker, daemon=True).start()
    print(f"[MODEL_SERVICE] Starting server on {APP_HOST}:{APP_PORT}...")
    # debug=False to avoid double loading or thread issues
    app.run(host=APP_HOST, port=APP_PORT, threaded=True, debug=False)
