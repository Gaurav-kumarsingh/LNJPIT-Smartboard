import fitz  # PyMuPDF
import sys, io, os, re, json

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# ─── Subject / Topic classification ──────────────────────────────────────────
SUBJECT_RULES = [
    ("Operating System",       ["scheduling", "deadlock", "semaphore", "mutex", "page replacement",
                                 "virtual memory", "process", "thread", "critical section",
                                 "monitor", "memory management", "demand paging", "tlb",
                                 "banker's algorithm", "context switch", "inter-process"]),
    ("DBMS",                   ["database", "sql", "relation", "normal form", "normalization",
                                 "functional dependency", "transaction", "acid", "b+ tree",
                                 "er diagram", "serializability", "tuple", "lossless",
                                 "candidate key", "primary key", "foreign key"]),
    ("Computer Networks",      ["network", "tcp", "udp", "ip", "router", "subnet", "protocol",
                                 "mac address", "arp", "dns", "http", "bandwidth", "sliding window",
                                 "ospf", "bgp", "congestion", "ethernet", "lan", "wan"]),
    ("Data Structures",        ["linked list", "binary tree", "avl", "heap", "stack", "queue",
                                 "hash table", "b-tree", "trie", "hashing", "traversal",
                                 "inorder", "preorder", "postorder", "red-black"]),
    ("Algorithms",             ["sorting", "searching", "dijkstra", "greedy", "dynamic programming",
                                 "time complexity", "space complexity", "big-o", "kruskal", "prim",
                                 "bellman", "backtracking", "divide and conquer",
                                 "recursion", "fibonacci", "topological"]),
    ("Theory of Computation",  ["automata", "grammar", "turing", "regular expression",
                                 "context free", "pushdown", "finite automata", "pda",
                                 "cfg", "chomsky", "dfa", "nfa", "language", "decidable",
                                 "undecidable", "halting problem"]),
    ("Engineering Mathematics",["matrix", "probability", "calculus", "eigenvalue", "set theory",
                                 "group theory", "differential equation", "permutation",
                                 "combination", "bayes", "variance", "integration",
                                 "graph coloring", "propositional", "predicate logic"]),
    ("Computer Organization",  ["instruction", "pipeline", "cache", "processor", "register",
                                 "memory hierarchy", "risc", "cisc", "addressing mode",
                                 "interrupt", "dma", "hardwired", "microprogrammed"]),
    ("Digital Logic",          ["boolean", "flip-flop", "multiplexer", "logic gate", "k-map",
                                 "combinational", "sequential", "adder", "decoder",
                                 "encoder", "counter", "truth table"]),
    ("General Aptitude",       []),  # fallback
]

TOPIC_MAP = {
    "Operating System": {
        "deadlock": "Deadlock", "semaphore": "Synchronization", "mutex": "Synchronization",
        "scheduling": "Scheduling", "page replacement": "Memory Management",
        "virtual memory": "Memory Management", "process": "Process Management",
        "thread": "Process Management", "critical section": "Synchronization",
        "memory management": "Memory Management", "tlb": "Memory Management",
        "banker": "Deadlock",
    },
    "DBMS": {
        "normal form": "Normalization", "normalization": "Normalization",
        "functional dependency": "Normalization", "transaction": "Transactions",
        "acid": "Transactions", "b+ tree": "Indexing", "sql": "SQL Queries",
        "serializability": "Transactions", "er diagram": "ER Model",
        "candidate key": "Keys & Constraints", "primary key": "Keys & Constraints",
    },
    "Computer Networks": {
        "tcp": "TCP/IP", "udp": "TCP/IP", "ip": "TCP/IP", "subnet": "TCP/IP",
        "router": "Routing", "ospf": "Routing", "bgp": "Routing",
        "sliding window": "Flow Control", "congestion": "Flow Control",
        "dns": "Application Layer", "http": "Application Layer",
        "arp": "Data Link Layer", "mac": "Data Link Layer",
    },
    "Data Structures": {
        "linked list": "Linked List", "binary tree": "Trees", "avl": "Trees",
        "heap": "Heap", "stack": "Stack & Queue", "queue": "Stack & Queue",
        "hash": "Hashing", "b-tree": "Trees", "trie": "Trees",
        "graph": "Graphs", "traversal": "Trees",
    },
    "Algorithms": {
        "sorting": "Sorting Algorithms", "dijkstra": "Graph Algorithms",
        "greedy": "Greedy Algorithms", "dynamic programming": "Dynamic Programming",
        "time complexity": "Complexity Analysis", "big-o": "Complexity Analysis",
        "kruskal": "Graph Algorithms", "prim": "Graph Algorithms",
        "divide and conquer": "Divide and Conquer",
    },
    "Theory of Computation": {
        "dfa": "Finite Automata", "nfa": "Finite Automata",
        "regular expression": "Regular Languages",
        "cfg": "Context-Free Languages", "pushdown": "Pushdown Automata",
        "pda": "Pushdown Automata", "turing": "Turing Machine",
        "grammar": "Context-Free Languages", "decidable": "Decidability",
        "halting": "Decidability",
    },
    "Engineering Mathematics": {
        "probability": "Probability", "matrix": "Linear Algebra",
        "eigenvalue": "Linear Algebra", "calculus": "Calculus",
        "differential equation": "Calculus", "permutation": "Combinatorics",
        "combination": "Combinatorics", "bayes": "Probability",
        "propositional": "Mathematical Logic", "predicate": "Mathematical Logic",
        "set theory": "Set Theory", "group theory": "Set Theory",
    },
    "Computer Organization": {
        "pipeline": "Pipelining", "cache": "Cache Memory",
        "instruction": "Instruction Execution", "register": "Registers",
        "addressing mode": "Addressing Modes", "interrupt": "I/O & Interrupts",
        "dma": "I/O & Interrupts",
    },
    "Digital Logic": {
        "boolean": "Boolean Algebra", "flip-flop": "Sequential Circuits",
        "multiplexer": "Combinational Circuits", "logic gate": "Boolean Algebra",
        "k-map": "Boolean Algebra", "adder": "Combinational Circuits",
        "decoder": "Combinational Circuits", "counter": "Sequential Circuits",
    },
    "General Aptitude": {},
}

def classify(question_text):
    text_lower = question_text.lower()
    subject = "General Aptitude"
    for subj, keywords in SUBJECT_RULES:
        if any(kw in text_lower for kw in keywords):
            subject = subj
            break

    # Topic
    topic = "General"
    if subject in TOPIC_MAP:
        for kw, top in TOPIC_MAP[subject].items():
            if kw in text_lower:
                topic = top
                break

    return subject, topic

def get_difficulty(question_text):
    length = len(question_text)
    # Count option lines to detect MCQ complexity
    options = len(re.findall(r'\([A-D]\)', question_text))
    has_code = bool(re.search(r'\bfor\b|\bwhile\b|\bif\b|\bint\b|\bvoid\b', question_text))
    
    if length > 600 or has_code:
        return "Hard"
    elif length > 280 or options >= 4:
        return "Medium"
    else:
        return "Easy"

def get_year_from_filename(filename):
    match = re.search(r'20\d{2}', filename)
    return int(match.group(0)) if match else 2000

def clean_question(text):
    # Remove page headers, noise
    text = re.sub(r'Computer Science and Information Technology \(CS\)\s*', '', text)
    text = re.sub(r'Page \d+ of \d+\s*', '', text)
    text = re.sub(r'Organizing Institute:[^\n]+', '', text)
    text = re.sub(r'General Aptitude \(GA\)\s*', '', text)
    text = re.sub(r'Q\.\s*\d+\s*–\s*Q\.\s*\d+.*?Each', '', text)
    # Collapse whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def process_pdfs(directory):
    all_questions = []
    question_id = 1
    seen = set()  # deduplication

    files = sorted(f for f in os.listdir(directory) if f.endswith('.pdf'))
    total_files = len(files)

    for idx, filename in enumerate(files):
        filepath = os.path.join(directory, filename)
        year = get_year_from_filename(filename)
        file_questions = 0

        try:
            doc = fitz.open(filepath)
            full_text = ""
            for page in doc:
                full_text += page.get_text() + "\n"

            # Split on Q.1, Q.2 … pattern
            parts = re.split(r'\n\s*Q\.?\s*(\d+)\s*\n', full_text)
            
            # parts is: [preamble, q_num, q_body, q_num, q_body, ...]
            i = 1
            while i < len(parts) - 1:
                q_body = parts[i + 1] if i + 1 < len(parts) else ""
                q_text = clean_question(q_body)

                if len(q_text) < 20:
                    i += 2
                    continue

                if len(q_text) > 1200:
                    q_text = q_text[:1200] + "..."

                # Dedup
                fingerprint = re.sub(r'\s+', '', q_text[:120]).lower()
                if fingerprint in seen:
                    i += 2
                    continue
                seen.add(fingerprint)

                subject, topic = classify(q_text)
                difficulty = get_difficulty(q_text)

                all_questions.append({
                    "id": question_id,
                    "year": year,
                    "subject": subject,
                    "topic": topic,
                    "difficulty": difficulty,
                    "question": q_text
                })
                question_id += 1
                file_questions += 1
                i += 2

        except Exception as e:
            print(f"  [SKIP] {filename}: {e}")

        print(f"[{idx+1}/{total_files}] {filename} → {file_questions} questions")

    return all_questions

if __name__ == "__main__":
    directory = "public/CS"
    print(f"Processing all PDFs in '{directory}'...\n")
    questions = process_pdfs(directory)

    out_path = "data/gate_questions.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(questions, f, indent=2, ensure_ascii=False)

    # Print summary stats
    by_year = {}
    by_subj = {}
    by_diff = {}
    for q in questions:
        by_year[q["year"]] = by_year.get(q["year"], 0) + 1
        by_subj[q["subject"]] = by_subj.get(q["subject"], 0) + 1
        by_diff[q["difficulty"]] = by_diff.get(q["difficulty"], 0) + 1

    print(f"\n✅ Total questions extracted: {len(questions)}")
    print("\n--- By Year ---")
    for y in sorted(by_year): print(f"  {y}: {by_year[y]}")
    print("\n--- By Subject ---")
    for s in sorted(by_subj): print(f"  {s}: {by_subj[s]}")
    print("\n--- By Difficulty ---")
    for d in sorted(by_diff): print(f"  {d}: {by_diff[d]}")
    print(f"\nSaved to: {out_path}")
