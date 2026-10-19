import http.server
import socketserver
import json
import os
import sys

PORT = 5173
DATA_FILE = os.path.join(os.path.dirname(__file__), "team_solutions_db.json")

class TeamCodingHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # CORS 및 캐시 방지 헤더 설정 (아무데서나 접속 시 캐시 문제 방지)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self.path == '/api/sync':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            if os.path.exists(DATA_FILE):
                with open(DATA_FILE, 'r', encoding='utf-8') as f:
                    self.wfile.write(f.read().encode('utf-8'))
            else:
                self.wfile.write(json.dumps({}).encode('utf-8'))
            return
        
        # 일반 정적 파일 서빙
        return super().do_GET()

    def do_POST(self):
        if self.path == '/api/sync':
            content_length = int(self.headers.get('Content-Length', 0))
            post_body = self.rfile.read(content_length)
            
            try:
                data = json.loads(post_body.decode('utf-8'))
                with open(DATA_FILE, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success", "message": "저장 완료"}).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))
            return

        self.send_response(404)
        self.end_headers()

def run_server():
    os.chdir(os.path.dirname(__file__))
    with socketserver.TCPServer(("", PORT), TeamCodingHandler) as httpd:
        print("==================================================")
        print(f"[SERVER READY] Coding Masters 100 Team Server Running")
        print(f"Address: http://localhost:{PORT}")
        print(f"Database: {DATA_FILE}")
        print("==================================================")
        sys.stdout.flush()
        httpd.serve_forever()

if __name__ == '__main__':
    run_server()
