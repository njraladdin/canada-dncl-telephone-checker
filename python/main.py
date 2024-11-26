from dotenv import load_dotenv
import os
from pathlib import Path
from extract_captcha_tokens_with_audio import CaptchaTokenExtractor as AudioCaptchaTokenExtractor
from extract_captcha_tokens_with_ai import CaptchaTokenExtractor as VisualCaptchaTokenExtractor
from extract_captcha_tokens_with_2captcha import CaptchaTokenExtractor as TwoCaptchaTokenExtractor
from send_dncl_request import send_dncl_request, TokenExpiredError
from typing import List, Optional, Dict
import asyncio
import sqlite3
from datetime import datetime
from colorama import init, Fore, Style, Back
import time
import threading
from progress_server import run_server

# Load the .env file from parent directory
load_dotenv('../.env')

# Add this constant at the top of the file after imports
BYPASSING_METHOD = '2captcha'  # can be 'audio', 'visual', or '2captcha'

class DatabaseManager:
    def __init__(self, db_path: str = "../numbers.db"):
        # Use relative path to access database in parent directory
        self.db_path = db_path
        self.setup_database()
    
    def setup_database(self):
        """Add DNCL-related columns if they don't exist"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        # Add new columns if they don't exist
        try:
            cursor.execute("""
                ALTER TABLE numbers 
                ADD COLUMN dncl_status TEXT
            """)
        except sqlite3.OperationalError:
            pass  # Column already exists
            
        try:
            cursor.execute("""
                ALTER TABLE numbers 
                ADD COLUMN dncl_registration_date TEXT
            """)
        except sqlite3.OperationalError:
            pass
            
        try:
            cursor.execute("""
                ALTER TABLE numbers 
                ADD COLUMN dncl_checked_at TEXT
            """)
        except sqlite3.OperationalError:
            pass  # Column already exists
            
        conn.commit()
        conn.close()
    
    def get_next_engineer(self) -> Optional[Dict]:
        """Get next engineer with null DNCL status and mobile phone"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        cursor.execute("""
            UPDATE numbers 
            SET dncl_status = 'PROCESSING'
            WHERE id = (
                SELECT id 
                FROM numbers 
                WHERE (dncl_status IS NULL OR dncl_status = '')
                AND telephone IS NOT NULL 
                AND phone_type = 'MOBILE'
                LIMIT 1
            )
            RETURNING id, telephone, nom, prenom
        """)
        
        row = cursor.fetchone()
        conn.commit()
        conn.close()
        
        if row:
            return dict(row)
        return None
    
    def get_unprocessed_count(self) -> int:
        """Get count of remaining unprocessed numbers"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT COUNT(*) as count 
            FROM numbers 
            WHERE (dncl_status IS NULL OR dncl_status = '')
            AND telephone IS NOT NULL 
            AND phone_type = 'MOBILE'
        """)
        
        count = cursor.fetchone()[0]
        conn.close()
        return count
    
    def update_engineer_dncl_status(self, engineer_id: int, dncl_result: Dict):
        """Update engineer's DNCL status based on API response"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        if dncl_result.get('status') == 'INVALID':
            status = 'INVALID'
            registration_date = None
        elif dncl_result.get('status') == 'ERROR':
            status = 'ERROR'
            registration_date = None
        else:
            status = 'ACTIVE' if dncl_result.get('Active', False) else 'INACTIVE'
            registration_date = dncl_result.get('AddedAt')
        
        current_time = datetime.now().isoformat()
        
        cursor.execute("""
            UPDATE numbers 
            SET dncl_status = ?,
                dncl_registration_date = ?,
                dncl_checked_at = ?
            WHERE id = ?
        """, (status, registration_date, current_time, engineer_id))
        
        conn.commit()
        conn.close()
    
    def reset_engineer_status(self, engineer_id: int):
        """Reset an engineer's DNCL status back to null"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute("""
            UPDATE numbers 
            SET dncl_status = NULL
            WHERE id = ?
        """, (engineer_id,))
        
        conn.commit()
        conn.close()

class TokenEventManager:
    def __init__(self):
        self.db = DatabaseManager()
        self.start_time = time.time()
        self.processed_count = 0
        self.total_initial_count = self.db.get_unprocessed_count()
        
        print(f"\n{Back.GREEN}{Fore.BLACK} STARTING DNCL PROCESSING {Style.RESET_ALL}")
        print(f"{Fore.CYAN}Numbers to process: {Fore.YELLOW}{self.total_initial_count}{Style.RESET_ALL}\n")
    
    def print_progress_stats(self):
        """Print colorful progress statistics"""
        if self.processed_count == 0:
            return
            
        remaining_count = self.db.get_unprocessed_count()
        if self.total_initial_count == 0:
            percent_complete = 100.0
        else:
            percent_complete = ((self.processed_count / self.total_initial_count) * 100)
        
        # Calculate time statistics
        elapsed_time = time.time() - self.start_time
        avg_time_per_request = elapsed_time / max(self.processed_count, 1)
        
        # Estimate remaining time
        estimated_time_remaining = avg_time_per_request * remaining_count
        hours = int(estimated_time_remaining // 3600)
        minutes = int((estimated_time_remaining % 3600) // 60)
        seconds = int(estimated_time_remaining % 60)
        
        # Format time remaining string
        if hours > 0:
            time_remaining = f"{hours}h {minutes}m"
        else:
            time_remaining = f"{minutes}m {seconds}s"
        
        print(f"\n{Back.GREEN}{Fore.BLACK} PROGRESS UPDATE {Style.RESET_ALL}")
        print(f"{Fore.CYAN}Progress: {Fore.YELLOW}{percent_complete:.2f}%")
        print(f"{Fore.CYAN}Numbers Remaining: {Fore.YELLOW}{remaining_count}")
        print(f"{Fore.CYAN}Avg Time Per Number: {Fore.YELLOW}{avg_time_per_request:.1f}s")
        print(f"{Fore.CYAN}Estimated Time Remaining: {Fore.YELLOW}{time_remaining}{Style.RESET_ALL}\n")
    
    async def on_token_found(self, token: str):
        """Called whenever a new token is found"""
        print(f"\n{Back.GREEN}{Fore.BLACK} NEW TOKEN RECEIVED {Style.RESET_ALL}")
        print(f"{Fore.CYAN}Token: {Fore.YELLOW}{token[:50]}...{Style.RESET_ALL}\n")
        
        while True:  # Keep processing numbers until token expires
            # Get next engineer to check
            engineer = self.db.get_next_engineer()
            if not engineer:
                print(f"{Fore.YELLOW}⚠️ No more numbers to check!{Style.RESET_ALL}")
                return
                
            # Send DNCL request
            phone = engineer['telephone']
            print(f"{Fore.CYAN}📞 Checking engineer {Fore.WHITE}{engineer['prenom']} {engineer['nom']} {Fore.YELLOW}({phone}){Style.RESET_ALL}")
            
            try:
                result = await send_dncl_request(phone, token)
                
                # Update engineer record
                self.db.update_engineer_dncl_status(engineer['id'], result)
                
                # Update progress
                self.processed_count += 1
                
                # Print result
                status = result.get('status', 'CHECKED')
                if status == 'ERROR':
                    print(f"{Fore.RED}❌ {phone}: Error - {result.get('error', 'Unknown error')}{Style.RESET_ALL}")
                elif status == 'INVALID':
                    print(f"{Fore.YELLOW}⚠️ {phone}: Invalid number{Style.RESET_ALL}")
                else:
                    is_active = result.get('Active', False)
                    status = "ACTIVE" if is_active else "INACTIVE"
                    color = Fore.GREEN if is_active else Fore.RED
                    print(f"{color}✅ {phone}: {status}{Style.RESET_ALL}")
                
                self.print_progress_stats()
                
            except TokenExpiredError:
                # Token has expired, mark the current number back as unprocessed
                self.db.reset_engineer_status(engineer['id'])
                print(f"{Fore.YELLOW}⚠️ Token expired, requesting new token...{Style.RESET_ALL}")
                return  # Exit to get new token
                
            except Exception as e:
                # If there's an error, mark the engineer as ERROR so we can retry later
                self.db.update_engineer_dncl_status(engineer['id'], {'status': 'ERROR', 'error': str(e)})
                print(f"{Fore.RED}❌ {phone}: {str(e)}{Style.RESET_ALL}")

def start_progress_server():
    """Start the Flask progress server in a separate thread"""
    server_thread = threading.Thread(target=run_server)
    server_thread.daemon = True  # This ensures the thread will be killed when the main program exits
    server_thread.start()

async def main():
    # Initialize colorama
    init(autoreset=True)
    
    # Validate .env file exists and is readable
    env_path = Path('../.env')
    if not env_path.exists():
        print(f"{Back.RED}{Fore.WHITE} Error: .env file not found at {env_path.absolute()} {Style.RESET_ALL}")
        print("Please make sure the .env file exists in the parent directory.")
        return

    # Validate database file exists and is accessible
    db_path = Path("../numbers.db")
    if not db_path.exists():
        print(f"{Back.RED}{Fore.WHITE} Error: Database file not found at {db_path.absolute()} {Style.RESET_ALL}")
        print("Please make sure the numbers.db file exists in the parent directory.")
        return

    # Test database connection
    try:
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM numbers")
        engineer_count = cursor.fetchone()[0]
        conn.close()
        print(f"{Back.GREEN}{Fore.BLACK} Database connection successful {Style.RESET_ALL}")
        print(f"{Fore.CYAN}Total numbers in database: {Fore.YELLOW}{engineer_count}{Style.RESET_ALL}\n")
    except sqlite3.Error as e:
        print(f"{Back.RED}{Fore.WHITE} Database connection error: {str(e)} {Style.RESET_ALL}")
        return

    # Test .env required variables
    required_env_vars = ['2CAPTCHA_API_KEY']  # Add any other required env variables here
    missing_vars = [var for var in required_env_vars if not os.getenv(var)]
    if missing_vars:
        print(f"{Back.RED}{Fore.WHITE} Error: Missing required environment variables: {', '.join(missing_vars)} {Style.RESET_ALL}")
        print("Please check your .env file contains all required variables.")
        return

    # Start the Flask progress server in a separate thread
    start_progress_server()
    # await asyncio.sleep(200)  # Just a tiny delay to prevent system overload

    # return 
    while True:  # Main infinite loop
        try:
            # Create our event manager
            event_manager = TokenEventManager()
            
            # Updated extractor selection logic
            if BYPASSING_METHOD == 'audio':
                ExtractorClass = AudioCaptchaTokenExtractor
            elif BYPASSING_METHOD == 'visual':
                ExtractorClass = VisualCaptchaTokenExtractor
            elif BYPASSING_METHOD == '2captcha':
                ExtractorClass = TwoCaptchaTokenExtractor
            else:
                raise ValueError(f"Invalid BYPASSING_METHOD: {BYPASSING_METHOD}")
            
            # Create the token extractor with our event handler
            extractor = ExtractorClass(
                tabs_per_browser=20,
                headless=True,
                on_token_found=event_manager.on_token_found
            )
            
            # Extract tokens
            print(f"\n{Back.BLUE}{Fore.WHITE} Starting new token extraction cycle {Style.RESET_ALL}")
            tokens = extractor.extract_tokens()
            
            print(f"\n{Back.GREEN}{Fore.BLACK} EXTRACTION CYCLE COMPLETE {Style.RESET_ALL}")
            print(f"{Fore.CYAN}Total tokens found in this cycle: {Fore.YELLOW}{len(tokens)}{Style.RESET_ALL}")
            
            # Minimal delay before starting next cycle
            await asyncio.sleep(2)  # Just a tiny delay to prevent system overload
            
        except Exception as e:
            print(f"\n{Back.RED}{Fore.WHITE} Error in main loop: {str(e)} {Style.RESET_ALL}")
            print("Waiting 30 seconds before retrying...")
            await asyncio.sleep(30)
            continue

if __name__ == "__main__":
    asyncio.run(main()) 