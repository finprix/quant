import { DataTable } from "../ui/Ui.jsx";

/**
 * Generic quant matrix: rows are metrics, columns are datasets.
 * Descriptive only — no winner highlighting.
 */
export default function ComparisonMatrix({ datasets, metrics, rowValues }) {
  const columns = [
    {
      key: "metric",
      header: "Metric",
      render: (row) => (
        <span>
          <span style={{ color: "var(--muted)", marginRight: 8, fontSize: 10 }}>
            {row.group}
          </span>
          {row.label}
        </span>
      ),
    },
    ...datasets.map((dataset) => ({
      key: `d${dataset.id}`,
      header: `#${dataset.id} ${dataset.filename}`,
      align: "right",
      mono: true,
      render: (row) => row.values[dataset.id] ?? "N/A",
    })),
  ];

  return (
    <DataTable
      columns={columns}
      rows={metrics.map((metric) => ({
        key: metric.key,
        group: metric.group,
        label: metric.label,
        values: Object.fromEntries(
          datasets.map((dataset) => [dataset.id, metric.value(rowValues.get(dataset.id))]),
        ),
      }))}
      emptyMessage="Select at least two datasets to compare."
    />
  );
}
