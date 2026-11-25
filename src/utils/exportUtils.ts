import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import ExcelJS from 'exceljs';
import type { Payslip } from '../types/hrms';

export interface ExcelSheetInput {
  name: string;
  headers: string[];
  rows: (string | number | boolean)[][];
}

export async function buildXlsxBuffer(sheets: ExcelSheetInput[]): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ACE HRMS — ACE Web Experts';
  workbook.created = new Date();

  for (const sheetInput of sheets) {
    const safeName = (sheetInput.name || 'Sheet1').replace(/[\\/*?:[\]]/g, '').slice(0, 31) || 'Sheet1';
    const ws = workbook.addWorksheet(safeName, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    const headerRow = ws.addRow(sheetInput.headers);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFF4634' },
      };
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    });
    headerRow.height = 24;

    for (const r of sheetInput.rows) {
      ws.addRow(r.map((val) => (val === undefined || val === null ? '' : val)));
    }

    sheetInput.headers.forEach((header, idx) => {
      const col = ws.getColumn(idx + 1);
      let maxLen = String(header || '').length + 4;
      for (const r of sheetInput.rows.slice(0, 200)) {
        const len = String(r[idx] ?? '').length + 2;
        if (len > maxLen) maxLen = len;
      }
      col.width = Math.min(Math.max(maxLen, 12), 48);
    });
  }

  return (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
}

export async function exportToXlsx(
  filename: string,
  headers: string[],
  rows: (string | number | boolean)[][],
  sheetName = 'Report',
): Promise<void> {
  await exportWorkbookToXlsx(filename, [{ name: sheetName, headers, rows }]);
}

export async function exportWorkbookToXlsx(filename: string, sheets: ExcelSheetInput[]): Promise<void> {
  const buffer = await buildXlsxBuffer(sheets);
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportToCsv(filename: string, headers: string[], rows: (string | number | boolean)[][]): void {
  const escapeCell = (cell: string | number | boolean) => {
    const str = String(cell ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const csvContent = [
    headers.map(escapeCell).join(','),
    ...rows.map((row) => row.map(escapeCell).join(',')),
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function formatCurrency(amount: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount || 0);
  } catch {
    return `${currency} ${(amount || 0).toFixed(2)}`;
  }
}

export function generatePayslipPdf(payslip: Payslip, companyName = 'ACE Web Experts', companyAddress = ''): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const resolvedAddress = companyAddress || (typeof window !== 'undefined' ? window.location.host : 'ACE HRMS');

  // Dark charcoal header banner (#0B0D12)
  doc.setFillColor(11, 13, 18);
  doc.rect(0, 0, 595, 96, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text(companyName, 40, 42);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(161, 161, 170);
  doc.text(`ACE HRMS · Official Payslip · ${resolvedAddress}`, 40, 62);

  doc.setTextColor(255, 106, 51);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(`PAY PERIOD: ${payslip.month}`, 430, 44);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(212, 212, 216);
  doc.text(`Status: ${payslip.status.toUpperCase()}`, 430, 62);

  // Employee Metadata
  doc.setTextColor(21, 25, 34);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Employee Details', 40, 130);

  autoTable(doc, {
    startY: 140,
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 6, textColor: [39, 39, 42] },
    headStyles: { fillColor: [244, 244, 245], textColor: [21, 25, 34], fontStyle: 'bold' },
    body: [
      ['Employee Name', payslip.employeeName, 'Employee ID', payslip.employeeCode || payslip.employeeId],
      ['Department', payslip.departmentName || '-', 'Designation', payslip.designation || '-'],
      ['Currency', payslip.currency, 'Unpaid Leave Days', String(payslip.unpaidLeaveDays ?? 0)],
      ['Overtime Hours', String(payslip.overtimeHours ?? 0), 'Payslip Reference', payslip.id],
    ],
  });

  const afterInfoY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 24;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Earnings & Deductions Breakdown', 40, afterInfoY);

  autoTable(doc, {
    startY: afterInfoY + 10,
    theme: 'striped',
    styles: { fontSize: 9.5, cellPadding: 7 },
    headStyles: { fillColor: [255, 70, 52], textColor: [255, 255, 255] },
    head: [['Component', 'Category', 'Amount']],
    body: [
      ['Basic Salary', 'Earnings', formatCurrency(payslip.basicSalary, payslip.currency)],
      ['Allowances (HRA / Transport / Special)', 'Earnings', formatCurrency(payslip.allowances, payslip.currency)],
      ['Bonuses', 'Earnings', formatCurrency(payslip.bonuses, payslip.currency)],
      ['Incentives', 'Earnings', formatCurrency(payslip.incentives, payslip.currency)],
      ['Overtime Pay', 'Earnings', formatCurrency(payslip.overtimePay, payslip.currency)],
      ['Gross Pay', 'Total Earnings', formatCurrency(payslip.grossPay, payslip.currency)],
      ['Unpaid Leave Adjustment', 'Deduction', `- ${formatCurrency(payslip.unpaidLeaveDeduction, payslip.currency)}`],
      ['Configured Deductions', 'Deduction', `- ${formatCurrency(payslip.otherDeductions, payslip.currency)}`],
    ],
  });

  const afterBreakdownY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 20;

  doc.setFillColor(255, 244, 242);
  doc.roundedRect(40, afterBreakdownY, 515, 48, 6, 6, 'F');
  doc.setTextColor(255, 70, 52);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('NET PAYABLE', 56, afterBreakdownY + 29);
  doc.setFontSize(16);
  doc.text(formatCurrency(payslip.netPay, payslip.currency), 400, afterBreakdownY + 30);

  doc.setTextColor(113, 113, 122);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(
    payslip.paymentNote || 'Note: Payslip generated in ACE HRMS per configured payroll rules. External bank transfer is processed separately.',
    40,
    afterBreakdownY + 75
  );

  doc.save(`Payslip_${payslip.employeeName.replace(/\s+/g, '_')}_${payslip.month}.pdf`);
}

export function generateReportPdf(
  title: string,
  subtitle: string,
  columns: string[],
  rows: (string | number)[][]
): void {
  const doc = new jsPDF({ orientation: columns.length > 6 ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  const width = doc.internal.pageSize.getWidth();

  doc.setFillColor(11, 13, 18);
  doc.rect(0, 0, width, 72, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(`ACE Web Experts — ${title}`, 36, 34);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(161, 161, 170);
  doc.text(`${subtitle} · Generated ${new Date().toLocaleString()}`, 36, 54);

  autoTable(doc, {
    startY: 92,
    head: [columns],
    body: rows.map((r) => r.map((c) => String(c ?? ''))),
    styles: { fontSize: 8.5, cellPadding: 5 },
    headStyles: { fillColor: [255, 70, 52], textColor: [255, 255, 255] },
    alternateRowStyles: { fillColor: [250, 250, 250] },
  });

  doc.save(`${title.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`);
}
