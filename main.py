from camoufox.sync_api import Camoufox
import time
import random
from browserforge.fingerprints import Screen

def visit_site(page):
    try:
        # Random initial delay (1-3 seconds)
        time.sleep(random.uniform(1, 3))
        
        print('Navigating to site...')
        page.goto('https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration/#!/')
        
        # Wait a bit to ensure page loads
        time.sleep(random.uniform(2, 4))
        
        print('Successfully loaded page')
        
        # Keep browser open until user interrupts
        print('\nBrowser will stay open until you press Ctrl+C...')
        while True:
            time.sleep(1)
            
    except KeyboardInterrupt:
        print('\nClosing browser...')
    except Exception as e:
        print(f'Error: {e}')

def main():
    # Initialize Camoufox with essential anti-detection settings
    with Camoufox(
        geoip=True,         # Location spoofing
        humanize=True,      # Human-like behavior
        screen=Screen(      # Common screen resolution
            min_width=1024,
            max_width=1920,
            min_height=768,
            max_height=1080
        ),
        os="windows",       # Windows fingerprint
        headless=False     # Make sure browser is visible
    
    ) as browser:
        page = browser.new_page()
        visit_site(page)

if __name__ == "__main__":
    main() 