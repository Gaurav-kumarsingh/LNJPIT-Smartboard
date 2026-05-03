import pypdf
import sys
import io
import os
import re
import json

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Heuristics for subjects and topics
SUBJECTS = ["Operating System", "DBMS", "Computer Networks", "Data Structures", "Algorithms", "Theory of Computation", "Engineering Mathematics", "General Aptitude", "Digital Logic", "Computer Organization"]
TOPICS = ["Deadlock", "Scheduling", "Normalization", "Trees", "Graphs", "TCP/IP", "Sorting Algorithms", "Boolean Algebra", "Pipelining", "Grammars", "Probability"]

def get_year_from_filename(filename):
    match = re.search(r'20\d{2}', filename)
    if match:
        return int(match.group(0))
    return 2000

def get_subject_topic(question_text):
    text_lower = question_text.lower()
    if "process" in text_lower or "scheduling" in text_lower or "deadlock" in text_lower or "memory" in text_lower:
        return "Operating System", "Scheduling"
    if "database" in text_lower or "sql" in text_lower or "relation" in text_lower or "normal form" in text_lower:
        return "DBMS", "Normalization"
    if "network" in text_lower or "tcp" in text_lower or "ip" in text_lower or "router" in text_lower:
        return "Computer Networks", "TCP/IP"
    if "tree" in text_lower or "graph" in text_lower or "array" in text_lower or "stack" in text_lower:
        return "Data Structures", "Trees"
    if "sort" in text_lower or "search" in text_lower or "time complexity" in text_lower:
        return "Algorithms", "Sorting Algorithms"
    if "automata" in text_lower or "grammar" in text_lower or "turing" in text_lower:
        return "Theory of Computation", "Grammars"
    if "matrix" in text_lower or "probability" in text_lower or "calculus" in text_lower:
        return "Engineering Mathematics", "Probability"
    return "General Aptitude", "General"

def get_difficulty(question_text):
    length = len(question_text)
    if length > 500:
        return "Hard"
    elif length > 200:
        return "Medium"
    else:
        return "Easy"

def process_pdfs(directory):
    all_questions = []
    question_id = 1
    
    files = [f for f in os.listdir(directory) if f.endswith('.pdf')]
    
    for filename in files:
        filepath = os.path.join(directory, filename)
        year = get_year_from_filename(filename)
        
        try:
            reader = pypdf.PdfReader(filepath)
            full_text = ""
            for page in reader.pages:
                extracted = page.extract_text()
                if extracted:
                    full_text += extracted + "\n"
                    
            # Basic regex to split questions (e.g., Q.1, Q.2 or Q1, Q2)
            # Find all matches of Q.\d+ or Q\d+
            questions_raw = re.split(r'\n\s*Q\.?\s*\d+\s*', full_text)
            
            # The first chunk is usually preamble/title
            for q_text in questions_raw[1:]:
                q_text = q_text.strip()
                # Remove extra whitespace/newlines
                q_text = re.sub(r'\s+', ' ', q_text)
                if len(q_text) < 10:
                    continue # Skip empty or invalid
                
                subject, topic = get_subject_topic(q_text)
                difficulty = get_difficulty(q_text)
                
                # truncate question if it's too long
                if len(q_text) > 1000:
                    q_text = q_text[:1000] + "..."
                
                all_questions.append({
                    "id": question_id,
                    "year": year,
                    "subject": subject,
                    "topic": topic,
                    "difficulty": difficulty,
                    "question": q_text
                })
                question_id += 1
                
                # Limit to first 200 questions to prevent massive json in this basic script
                if question_id > 2000: 
                    break
        except Exception as e:
            print(f"Error reading {filename}: {e}")
            
    return all_questions

if __name__ == "__main__":
    directory = "public/CS"
    questions = process_pdfs(directory)
    
    # Save to file
    out_path = "data/gate_questions.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(questions, f, indent=2, ensure_ascii=False)
        
    print(f"Extracted {len(questions)} questions to {out_path}")
