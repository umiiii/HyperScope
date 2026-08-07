import { AddressDetailView } from "@/components/address-detail";

type Props = { params: Promise<{ id: string }> };

export default async function AddressPage({ params }: Props) {
  const { id } = await params;
  return <AddressDetailView id={id} />;
}
