from flask import Flask, render_template_string, request
import sqlite3
from math import ceil

app = Flask(__name__)
app.jinja_env.globals.update(max=max, min=min)

# HTML template with Bootstrap styling
HTML_TEMPLATE = '''
<!DOCTYPE html>
<html>
<head>
    <title>DNCL Processing Results</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        .table-container { margin: 20px; }
        .pagination-container { margin: 20px; }
        .status-active { color: red !important; font-weight: bold; }
        .status-inactive { color: green !important; font-weight: bold; }
        .status-error { color: orange !important; }
        .status-invalid { color: gray !important; }
        .status-processing { color: blue !important; }
        .status-pending { color: #666 !important; }
        .progress { height: 25px; }
    </style>
</head>
<body>
    <div class="table-container">
        <h2>DNCL Processing Results</h2>
        
        <!-- Add progress stats section -->
        <div class="card mb-4">
            <div class="card-body">
                <h5 class="card-title">Processing Progress</h5>
                <div class="progress mb-3">
                    <div class="progress-bar" role="progressbar" 
                         style="width: {{ progress_percentage }}%;" 
                         aria-valuenow="{{ progress_percentage }}" 
                         aria-valuemin="0" 
                         aria-valuemax="100">
                        {{ "%.1f"|format(progress_percentage) }}%
                    </div>
                </div>
                <p class="card-text">
                    Processed: {{ processed_count }} out of {{ total_count }} numbers
                </p>
            </div>
        </div>

        <table class="table table-striped table-hover">
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Phone</th>
                    <th>Status</th>
                    <th>Registration Date</th>
                    <th>Checked At</th>
                </tr>
            </thead>
            <tbody>
                {% for row in rows %}
                <tr>
                    <td>{{ row.prenom }} {{ row.nom }}</td>
                    <td>{{ row.telephone }}</td>
                    <td class="status-{{ row.dncl_status }}">
                        {{ row.dncl_status|upper if row.dncl_status else 'PENDING' }}
                    </td>
                    <td>{{ row.dncl_registration_date or '-' }}</td>
                    <td>{{ row.dncl_checked_at or '-' }}</td>
                </tr>
                {% endfor %}
            </tbody>
        </table>
        
        <div class="pagination-container">
            <nav>
                <ul class="pagination">
                    {% if page > 1 %}
                    <li class="page-item">
                        <a class="page-link" href="?page={{ page - 1 }}">Previous</a>
                    </li>
                    {% endif %}
                    
                    {% for p in range(max(1, page - 2), min(total_pages + 1, page + 3)) %}
                    <li class="page-item {{ 'active' if p == page else '' }}">
                        <a class="page-link" href="?page={{ p }}">{{ p }}</a>
                    </li>
                    {% endfor %}
                    
                    {% if page < total_pages %}
                    <li class="page-item">
                        <a class="page-link" href="?page={{ page + 1 }}">Next</a>
                    </li>
                    {% endif %}
                </ul>
            </nav>
        </div>
    </div>
</body>
</html>
'''

@app.route('/')
def index():
    # Get page number from query parameters
    page = int(request.args.get('page', 1))
    per_page = 50  # Number of records per page
    
    # Connect to database
    conn = sqlite3.connect('../numbers.db')
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Get total count and processed count for progress calculation
    cursor.execute('''
        SELECT 
            COUNT(*) as total,
            COUNT(CASE WHEN dncl_status IS NOT NULL THEN 1 END) as processed
        FROM numbers
        WHERE telephone IS NOT NULL 
        AND phone_type = 'MOBILE'
    ''')
    counts = cursor.fetchone()
    total_count = counts['total']
    processed_count = counts['processed']
    
    # Calculate progress percentage
    progress_percentage = (processed_count / total_count * 100) if total_count > 0 else 0
    
    # Get total count for pagination
    cursor.execute('SELECT COUNT(*) FROM numbers WHERE dncl_checked_at IS NOT NULL')
    total_records = cursor.fetchone()[0]
    total_pages = ceil(total_records / per_page)
    
    # Get paginated results
    offset = (page - 1) * per_page
    cursor.execute('''
        SELECT 
            nom, 
            prenom, 
            telephone, 
            LOWER(dncl_status) as dncl_status, 
            dncl_registration_date, 
            dncl_checked_at
        FROM numbers 
        WHERE dncl_checked_at IS NOT NULL
        ORDER BY dncl_checked_at DESC
        LIMIT ? OFFSET ?
    ''', (per_page, offset))
    
    rows = cursor.fetchall()
    conn.close()
    
    return render_template_string(
        HTML_TEMPLATE,
        rows=rows,
        page=page,
        total_pages=total_pages,
        progress_percentage=progress_percentage,
        processed_count=processed_count,
        total_count=total_count
    )

def run_server():
    app.run(host='0.0.0.0', port=5000) 