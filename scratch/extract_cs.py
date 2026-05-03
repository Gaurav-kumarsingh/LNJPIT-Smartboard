import pypdf
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

def extract_pdf_text(filepath):
    try:
        reader = pypdf.PdfReader(filepath)
        text = ""
        # Only read the first 5 pages to keep context small
        num_pages = min(5, len(reader.pages))
        for i in range(num_pages):
            page = reader.pages[i]
            text += page.extract_text() + "\n---PAGE BREAK---\n"
        return text
    except Exception as e:
        return f"Error: {e}"

if __name__ == "__main__":
    text = extract_pdf_text("public/CS/CS2023.pdf")
    with open("scratch/cs2023_text.txt", "w", encoding="utf-8") as f:
        f.write(text)
    print("Done extracting CS2023.pdf")
